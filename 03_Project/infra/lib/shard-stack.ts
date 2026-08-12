/**
 * 샤드 평면 — 1번 문제(813시간 직렬)를 푸는 부분.
 *
 * 샤드 하나는 **(SUT + k6 + 워커) 한 벌**이고, 샤드끼리는 아무것도 공유하지 않는다.
 * 공유하면 안 되는 것은 SUT다 — 두 워커가 같은 SUT를 때리면 서로의 배경 부하가
 * 합산되어, 셀 정의에 적힌 부하 수준이 실제 부하와 달라진다. 부하가 외생이어야
 * 한다는 제약이 곧 "샤드마다 SUT를 따로 둔다"를 강제한다.
 *
 * ALB를 두지 않는 이유는 README에 적었다 — 요약하면 홉과 분산만 늘고 실험적으로
 * 얻는 것이 없으며, CloudFront는 캐시 상태 축을 교란한다. 워커와 부하 생성기는
 * Cloud Map 사설 DNS(`sut-<i>.ugrp.local`)로 자기 샤드의 SUT에 직접 붙는다.
 */
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import {
  CollectionConfig,
  ImageDigests,
  LOAD_CONTROL_PORT,
  NAMESPACE,
  SUT_PORT,
  TASK_SIZE,
  requireDigests,
} from './config'

export interface ShardStackProps extends StackProps {
  vpc: ec2.Vpc
  sutSg: ec2.SecurityGroup
  workerSg: ec2.SecurityGroup
  loadSg: ec2.SecurityGroup
  results: s3.Bucket
  checkpoint: dynamodb.Table
  repos: { sut: ecr.Repository; worker: ecr.Repository; load: ecr.Repository }
  collection: CollectionConfig
  digests: Partial<ImageDigests>
}

export class ShardStack extends Stack {
  readonly cluster: ecs.Cluster
  /** 오케스트레이션이 RunTask로 띄우는 대상. 샤드 순서와 인덱스가 같다. */
  readonly workerTaskDefinitions: ecs.FargateTaskDefinition[] = []

  constructor(scope: Construct, id: string, props: ShardStackProps) {
    super(scope, id, props)

    const { collection } = props
    // 태그로 우회할 여지를 합성 단계에서 없앤다.
    const digests = requireDigests(props.digests, id)

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      // 컨테이너 인사이트는 태스크당 과금된다. 60태스크 × 41시간이면 무시할 수 없고,
      // 우리가 보는 지표는 SUT가 스스로 내보내는 /api/internal/metrics다.
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    })

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: NAMESPACE,
      vpc: props.vpc,
    })

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    /*
     * 역할은 샤드마다 만들지 않고 공유한다.
     *
     * 태스크 정의마다 실행 역할·태스크 역할이 자동 생성되면 샤드 20개에 역할만 120개가
     * 되고, 스택 리소스가 300을 넘어 CloudFormation 한도(500)에 금방 닿는다. 샤드는
     * **같은 이미지로 같은 일을 하는 복제본**이라 권한이 다를 이유가 없다 — 역할을
     * 나눠도 격리되는 것이 없다. 격리해야 하는 것은 SUT이고, 그건 태스크 단위로
     * 이미 갈라져 있다.
     */
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS agent: pull images, write logs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    })
    // 워커만 결과와 체크포인트에 쓴다. SUT·부하 생성기는 아무 데이터에도 닿지 않는다.
    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Measurement worker: write results and checkpoints',
    })
    props.results.grantPut(workerRole)
    props.checkpoint.grantReadWriteData(workerRole)

    const inertRole = new iam.Role(this, 'InertRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'SUT and load generator: no AWS access needed',
    })

    const roles = { executionRole, workerRole, inertRole }
    for (let i = 0; i < collection.totalShards; i++) {
      this.buildShard(i, { ...props, digests }, namespace, logGroup, roles)
    }

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName })
    new CfnOutput(this, 'ShardCount', { value: String(collection.totalShards) })

    /*
     * 워커·부하 태스크는 서비스가 아니라 RunTask로 뜬다(끝나면 끝나야 하는 일이다).
     * 서비스가 아니면 보안 그룹과 서브넷이 태스크 정의가 아니라 **실행 시점의
     * 네트워크 구성**으로 들어간다. 오케스트레이션이 그 값을 알아야 하므로 내보낸다 —
     * 여기서 빠지면 실행 쪽에서 기본 SG를 쓰게 되고, 워커와 부하 생성기를 갈라놓은
     * 의미가 사라진다.
     */
    new CfnOutput(this, 'WorkerSecurityGroup', { value: props.workerSg.securityGroupId })
    new CfnOutput(this, 'LoadSecurityGroup', { value: props.loadSg.securityGroupId })
    new CfnOutput(this, 'MeasureSubnets', {
      value: props.vpc.selectSubnets({ subnetGroupName: 'measure' }).subnetIds.join(','),
    })
    new CfnOutput(this, 'LoadSubnets', {
      value: props.vpc.selectSubnets({ subnetGroupName: 'load' }).subnetIds.join(','),
    })
  }

  private buildShard(
    index: number,
    props: ShardStackProps & { digests: ImageDigests },
    namespace: servicediscovery.PrivateDnsNamespace,
    logGroup: logs.LogGroup,
    roles: { executionRole: iam.Role; workerRole: iam.Role; inertRole: iam.Role },
  ) {
    const { collection, digests } = props
    const pad = String(index).padStart(2, '0')
    const sutHost = `sut-${pad}.${NAMESPACE}`
    const baseUrl = `http://${sutHost}:${SUT_PORT}`

    const logging = (prefix: string) =>
      ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: `${prefix}-${pad}` })

    // ── SUT ───────────────────────────────────────────────────────────────
    const sutTask = new ecs.FargateTaskDefinition(this, `SutTask${pad}`, {
      cpu: TASK_SIZE.sut.cpu,
      memoryLimitMiB: TASK_SIZE.sut.memoryMiB,
      executionRole: roles.executionRole,
      taskRole: roles.inertRole,
    })
    sutTask.addContainer('sut', {
      image: ecs.ContainerImage.fromEcrRepository(props.repos.sut, digests.sut),
      logging: logging('sut'),
      portMappings: [{ containerPort: SUT_PORT }],
      environment: { NODE_ENV: 'production', PORT: String(SUT_PORT) },
    })

    /*
     * desiredCount 1 고정, 오토스케일 없음(제안서 §5.3).
     *
     * 오토스케일이 붙으면 부하가 올라갈 때 태스크가 늘어 CPU%가 목표로 수렴하지
     * 않는다. 그러면 부하 수준이라는 축 자체가 성립하지 않는다.
     *
     * circuitBreaker는 켜되 **롤백은 끈다.** 켜지 않으면 태스크가 못 뜨는 배포가
     * 최대 3시간 뒤에야 실패한다. 반대로 롤백까지 켜면 실패한 이미지가 조용히 이전
     * 버전으로 되돌아가, 그 샤드가 다른 이미지로 측정하는데도 드러나지 않는다 —
     * 이미지를 다이제스트로 고정한 이유가 그대로 무너진다.
     */
    new ecs.FargateService(this, `Sut${pad}`, {
      cluster: this.cluster,
      taskDefinition: sutTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetGroupName: 'sut' },
      securityGroups: [props.sutSg],
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: `sut-${pad}`,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
      // 태스크가 죽으면 다시 띄우되, 헬스체크 유예를 넉넉히 준다 — Next 기동은 빠르지만
      // 콜드 스타트 중 워커가 붙으면 그 측정이 워밍업에 오염된다.
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: false },
    })

    // ── 측정 워커 ─────────────────────────────────────────────────────────
    const workerTask = new ecs.FargateTaskDefinition(this, `WorkerTask${pad}`, {
      cpu: TASK_SIZE.worker.cpu,
      memoryLimitMiB: TASK_SIZE.worker.memoryMiB,
      executionRole: roles.executionRole,
      taskRole: roles.workerRole,
    })
    workerTask.addContainer('worker', {
      image: ecs.ContainerImage.fromEcrRepository(props.repos.worker, digests.worker),
      logging: logging('worker'),
      environment: {
        BASE_URL: baseUrl,
        // UGRP_EXPERIMENT는 두지 않는다 — run.mjs는 소비하지 않고, 데이터
        // 네임스페이스는 command의 --name이 결정한다. 태스크 정의를 읽는 사람이
        // 이 변수가 S3 프리픽스를 정한다고 오해하는 이중 소스였다.
        UGRP_RESULTS_BUCKET: props.results.bucketName,
        UGRP_CHECKPOINT_TABLE: props.checkpoint.tableName,
        UGRP_SHARD_INDEX: String(index),
        UGRP_SHARD_COUNT: String(collection.totalShards),
        // 이게 있으면 run.mjs가 원격 부하 모드로 간다 — 저장된 캘리브레이션을 믿지 않고
        // 여기서 새로 이진 탐색한다.
        LOAD_CONTROL_URL: `http://load-${pad}.${NAMESPACE}:${LOAD_CONTROL_PORT}`,
      },
      command: [
        '--name', collection.runName,
        '--reps', String(collection.reps),
        '--seed', collection.seed,
        '--shard-index', String(index),
        '--shard-count', String(collection.totalShards),
        // 슬라이스 필터. 부하 축은 위의 샤드 배정이 담당하므로 여기에 --loads는 없다.
        ...collection.filters,
      ],
    })

    /*
     * ── 배경 부하 ─────────────────────────────────────────────────────────
     *
     * 태스크가 아니라 **서비스**다. 워커가 Cloud Map으로 찾아 제어해야 하는데,
     * RunTask로 뜬 태스크에는 안정적인 이름이 없다. control.mjs는 VU 0으로 떠서
     * 지시를 기다리므로, 항상 떠 있어도 부하를 주지 않는다.
     *
     * 대가는 idle 샤드에서도 이 태스크가 돈다는 것이다(20샤드 41시간에 약 $49).
     * 부하가 필요한 샤드만 띄우려면 어느 샤드가 어느 부하 수준인지를 CDK가 알아야
     * 하고, 그건 workers/lib/shard.mjs의 배분 규칙을 TS로 한 벌 더 옮긴다는 뜻이다.
     * 어긋날 수 있는 사본을 만드는 것보다 $49가 싸다.
     */
    const loadTask = new ecs.FargateTaskDefinition(this, `LoadTask${pad}`, {
      cpu: TASK_SIZE.load.cpu,
      memoryLimitMiB: TASK_SIZE.load.memoryMiB,
      executionRole: roles.executionRole,
      taskRole: roles.inertRole,
    })
    loadTask.addContainer('load', {
      image: ecs.ContainerImage.fromEcrRepository(props.repos.load, digests.load),
      logging: logging('load'),
      portMappings: [{ containerPort: LOAD_CONTROL_PORT }],
      environment: { BASE_URL: baseUrl, CONTROL_PORT: String(LOAD_CONTROL_PORT) },
      /*
       * VU 수는 여기에 없다. 캘리브레이션이 태스크 크기에 종속이라 워커가 실행
       * 시점에 이진 탐색으로 잡는다 — 여기에 상수로 박으면 그 숫자가
       * calibration.generated.json과 어긋날 수 있는 사본이 된다.
       */
    })

    /*
     * SUT와 부하 생성기는 서비스라 계속 떠 있다. 실행할 때 뜨고 끝나면 끝나야 하는
     * 것은 **워커뿐**이라, 오케스트레이션이 RunTask로 띄우는 대상도 워커 하나다.
     * 캘리브레이션 → 부하 투입 → 측정 순서는 워커 안에 있다(run.mjs의 부하 그룹 루프).
     */
    new ecs.FargateService(this, `Load${pad}`, {
      cluster: this.cluster,
      taskDefinition: loadTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetGroupName: 'load' },
      securityGroups: [props.loadSg],
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: `load-${pad}`,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: false },
    })

    this.workerTaskDefinitions.push(workerTask)

    new CfnOutput(this, `Shard${pad}`, {
      value: JSON.stringify({ baseUrl, loadControl: `load-${pad}.${NAMESPACE}:${LOAD_CONTROL_PORT}` }),
      description: `샤드 ${pad}`,
    })
  }
}
