/**
 * 네트워크 평면.
 *
 * 요구사항 두 개가 모양을 결정한다:
 *
 *  1. **부하 생성기와 측정 워커는 서로 다른 서브넷·보안 그룹에 둔다**(제안서 §5.3).
 *     같은 SG에 두면 둘 사이 트래픽이 허용되어, 부하 생성기가 워커의 대역을 잠식해도
 *     드러나지 않는다. 측정하려는 것은 SUT의 부하이지 워커의 부하가 아니다.
 *
 *  2. **NAT 게이트웨이를 두지 않는다.** 태스크가 인터넷에 나갈 이유가 없다 —
 *     이미지는 ECR, 결과는 S3, 체크포인트는 DynamoDB다. 전부 VPC 엔드포인트로
 *     닿는다. NAT는 시간당 요금에 더해 GB당 요금이 붙는데, 샤드 20개가 1.5GB짜리
 *     Playwright 이미지를 각자 당기면 그 자체로 무시 못 할 금액이 된다.
 *
 * 인터넷 경로가 없다는 것은 곧 **측정이 외부 요인에 노출되지 않는다**는 뜻이기도 하다.
 */
import { Stack, StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { LOAD_CONTROL_PORT, MAX_AZS, SUT_PORT } from './config'

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc
  readonly sutSg: ec2.SecurityGroup
  readonly workerSg: ec2.SecurityGroup
  readonly loadSg: ec2.SecurityGroup

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: MAX_AZS,
      natGateways: 0,
      subnetConfiguration: [
        // SUT — 워커·부하 생성기만 닿는다.
        { name: 'sut', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
        // 측정 워커 — 부하 생성기와 서브넷을 나눈다.
        { name: 'measure', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
        // 부하 생성기.
        { name: 'load', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    })

    // ── VPC 엔드포인트 ────────────────────────────────────────────────────
    // 게이트웨이 엔드포인트는 무료다. S3는 이미지 레이어와 결과 업로드 양쪽에 쓰인다.
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 })
    this.vpc.addGatewayEndpoint('Dynamo', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB })

    // 인터페이스 엔드포인트는 AZ당 시간당 요금이 있다. AZ를 하나로 고정한 이유 중 하나다.
    for (const [id2, service] of [
      ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ] as const) {
      this.vpc.addInterfaceEndpoint(id2, { service, privateDnsEnabled: true })
    }

    // ── 보안 그룹 ─────────────────────────────────────────────────────────
    // CloudFormation은 GroupDescription·규칙 설명에 ASCII만 받는다. 한국어 근거는 주석에 둔다.
    this.sutSg = new ec2.SecurityGroup(this, 'SutSg', {
      vpc: this.vpc,
      description: 'SUT: ingress only from measurement workers and load generators',
      allowAllOutbound: true,
    })
    this.workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: this.vpc,
      description: 'Measurement workers: no ingress',
      allowAllOutbound: true,
    })
    this.loadSg = new ec2.SecurityGroup(this, 'LoadSg', {
      vpc: this.vpc,
      description: 'Load generators: no ingress',
      allowAllOutbound: true,
    })

    this.sutSg.addIngressRule(this.workerSg, ec2.Port.tcp(SUT_PORT), 'measurement requests')
    this.sutSg.addIngressRule(this.loadSg, ec2.Port.tcp(SUT_PORT), 'background load')

    /*
     * 워커 → 부하 생성기, 제어 포트만.
     *
     * 캘리브레이션이 워커 쪽에 있어서 필요한 규칙이다 — 워커가 VU 수를 지시하고
     * 상태를 읽는다. **방향이 중요하다.** 반대 방향(부하 → 워커)은 열지 않는다.
     * 부하 트래픽은 부하 생성기 → SUT로만 흘러야 하고, 워커로 새면 측정하는 것이
     * SUT의 부하인지 워커의 혼잡인지 갈라지지 않는다.
     */
    this.loadSg.addIngressRule(
      this.workerSg,
      ec2.Port.tcp(LOAD_CONTROL_PORT),
      'worker drives calibration (control plane only)',
    )
  }
}
