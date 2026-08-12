/**
 * 서빙 오리진 — 공개 ALB + SUT.
 *
 * 랩 평면의 SUT는 사설 서브넷에 있고 인터넷 경로가 아예 없다. CloudFront가 닿지
 * 못하므로 필드 실험에는 공개 오리진이 따로 필요하다.
 *
 * **랩 VPC를 쓰지 않는다.** 거기에 인터넷 게이트웨이를 달면 "랩 경로에는 인터넷
 * 경로가 없어 측정이 외부 요인에 노출되지 않는다"는 근거가 그대로 무너진다. 리전도
 * 어차피 다르게 잡을 수 있어야 한다 — 오리진은 ap-northeast-2에 고정하고(제안서의
 * RTT 기준점), Lambda@Edge는 us-east-1에만 만들 수 있다.
 *
 * **ALB는 CloudFront에서 오는 트래픽만 받는다.** 이건 보안 문제이기 이전에
 * 실험 무결성 문제다 — ALB를 직접 때릴 수 있으면 그 요청은 결정 계층을 건너뛰고,
 * 모드가 정해지지 않은 채(또는 앱 기본값으로) 렌더된 데이터가 필드 로그에 섞인다.
 */
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as iam from 'aws-cdk-lib/aws-iam'
import { RemovalPolicy } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { SUT_PORT, TASK_SIZE } from './config'

export interface ServingOriginStackProps extends StackProps {
  /** SUT 이미지 다이제스트. 랩과 **같은 이미지**여야 결과를 나란히 볼 수 있다. */
  sutDigest: string
  /** 랩 데이터 평면의 ECR 저장소 이름. 같은 계정·리전이면 그대로 쓴다. */
  sutRepositoryName: string
  /**
   * CloudFront 관리형 프리픽스 리스트 ID (`com.amazonaws.global.cloudfront.origin-facing`).
   * 리전마다 다르다:
   *   aws ec2 describe-managed-prefix-lists --region <리전> \
   *     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
   */
  cloudfrontPrefixListId: string
  /** 서비스 태스크 수. 오토스케일은 켜지 않는다 — 아래 참조. */
  desiredCount: number
}

export class ServingOriginStack extends Stack {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer

  constructor(scope: Construct, id: string, props: ServingOriginStackProps) {
    super(scope, id, props)

    if (!props.sutDigest.startsWith('sha256:')) {
      throw new Error(`[${id}] sutDigest가 sha256:로 시작하지 않는다: ${props.sutDigest}`)
    }
    if (!/^pl-[0-9a-f]+$/.test(props.cloudfrontPrefixListId)) {
      throw new Error(
        `[${id}] CloudFront 프리픽스 리스트 ID가 필요하다 (받은 값: ${props.cloudfrontPrefixListId})\n` +
          '  aws ec2 describe-managed-prefix-lists --region <리전> \\\n' +
          '    --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing\n' +
          '  이걸 생략하고 ALB를 열어두면 결정 계층을 건너뛴 요청이 필드 로그에 섞인다.',
      )
    }

    /*
     * 랩 VPC와 달리 AZ가 둘이다. 랩에서 AZ를 하나로 고정한 이유는 측정 안정성이었는데
     * (AZ를 넘으면 RTT 노이즈가 실린다), 여기서는 실사용자를 받는 경로라 가용성이 우선이다.
     *
     * NAT 없이 공개 서브넷에 태스크를 둔다. NAT는 AZ당 시간당 요금이 붙는데, 얻는 것은
     * "태스크에 공개 IP가 없다"뿐이다. 인그레스는 아래 SG가 ALB로만 막으므로 실질적인
     * 노출 차이가 없다.
     */
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 }],
    })

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Serving ALB: ingress from CloudFront edge only',
      allowAllOutbound: true,
    })
    /*
     * CloudFront 엣지 대역만 받는다. 0.0.0.0/0으로 열면 누구나 ALB를 직접 때릴 수 있고,
     * 그 요청은 x-render-mode 없이 오리진에 닿아 결정 계층을 건너뛴다 — 필드 데이터에
     * "어떤 정책도 적용되지 않은 관측"이 섞이는데 사후에 구분할 방법이 없다.
     */
    albSg.addIngressRule(
      ec2.Peer.prefixList(props.cloudfrontPrefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing ranges only',
    )

    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Serving SUT: ingress from the ALB only',
      allowAllOutbound: true,
    })
    taskSg.addIngressRule(albSg, ec2.Port.tcp(SUT_PORT), 'ALB to SUT')

    // ── SUT 서비스 ────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    })

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS agent: pull images, write logs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    })

    const taskDef = new ecs.FargateTaskDefinition(this, 'SutTask', {
      // 랩과 같은 크기. 다르면 서버 부하 피처의 스케일이 달라져 랩에서 학습한 모델이
      // 필드에서 다른 것을 보게 된다.
      cpu: TASK_SIZE.sut.cpu,
      memoryLimitMiB: TASK_SIZE.sut.memoryMiB,
      executionRole,
    })

    const repo = ecr.Repository.fromRepositoryName(this, 'SutRepo', props.sutRepositoryName)
    taskDef.addContainer('sut', {
      image: ecs.ContainerImage.fromEcrRepository(repo, props.sutDigest),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'sut' }),
      portMappings: [{ containerPort: SUT_PORT }],
      environment: {
        NODE_ENV: 'production',
        PORT: String(SUT_PORT),
        // cpuPct 분모 — 랩(shard-stack)과 같은 이유·같은 유도식. 어긋나면 서버 부하
        // 피처의 스케일이 랩과 달라져 모델이 필드에서 다른 것을 본다.
        SUT_CPU_CORES: String(TASK_SIZE.sut.cpu / 1024),
      },
    })

    /*
     * **오토스케일을 켜지 않는다.** 서버 부하는 모델의 피처이고, 부하가 오르면 태스크가
     * 느는 구조에서는 그 피처가 정책의 결정에 반응하게 된다 — 랩에서 부하를 외생으로
     * 고정한 이유가 필드에서 그대로 무너진다. 용량은 실험 조건으로 고정한다.
     */
    const service = new ecs.FargateService(this, 'Sut', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      // 공개 서브넷 + 공개 IP. ECR·로그에 NAT 없이 닿기 위한 것이고, 인그레스는 SG가 막는다.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      healthCheckGracePeriod: Duration.seconds(60),
      circuitBreaker: { enable: true, rollback: false },
      /*
       * 배포 중에도 절반은 살려둔다. 랩 평면은 0/100(멈췄다 뜬다)이었지만 여기는
       * 실사용자를 받는 경로다. 100/200이 아닌 이유는 용량이 실험 조건이기 때문 —
       * 배포 중 잠깐이라도 태스크가 두 배가 되면 그 구간의 서버 부하 피처가 다른 값이 된다.
       */
      minHealthyPercent: 50,
      maxHealthyPercent: 100,
    })

    // ── ALB ───────────────────────────────────────────────────────────────
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(60),
    })

    const listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // SG는 위에서 CloudFront 대역으로만 열었다. open:true면 그걸 되돌린다.
    })

    listener.addTargets('Sut', {
      port: SUT_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      /*
       * 헬스체크는 라우트 테이블 엔드포인트로 한다. 포트가 열렸는지가 아니라 앱이
       * 실제로 응답할 수 있는지를 봐야, 콜드 스타트 중인 태스크로 트래픽이 가지 않는다.
       */
      healthCheck: {
        path: '/api/internal/routes',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(15),
    })

    new CfnOutput(this, 'OriginDomainName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: '서빙 스택에 넘길 값 — -c ugrp:servingOrigin=<이 값>',
    })
  }
}
