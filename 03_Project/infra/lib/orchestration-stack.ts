/**
 * 오케스트레이션 — 샤드 20개를 동시에 돌리고 끝날 때까지 붙잡는다.
 *
 * **띄우는 것은 워커뿐이다.** SUT와 부하 생성기는 서비스라 이미 떠 있고, 워커만
 * 끝나면 끝나야 하는 일이라 RunTask다. 캘리브레이션 → 부하 투입 → 측정 순서는
 * 상태 기계가 아니라 워커 안에 있다(run.mjs의 부하 그룹 루프) — 그 순서는 실험
 * 절차이지 인프라 흐름이 아니고, 로컬 실행과 같은 코드로 돌아가야 비교가 된다.
 *
 * 그래서 상태 기계가 하는 일은 셋뿐이다: 부채꼴로 펼치고, 끝날 때까지 기다리고,
 * 실패를 감춘 채 성공으로 보고하지 않는 것.
 *
 * **Distributed Map이 아니라 일반 Map을 쓴다.** 제안서 §5.3은 Distributed Map을
 * 적었는데, 그건 셀 10,400개를 항목으로 펼치는 설계였다. 정적 샤딩으로 바뀌면서
 * 항목이 20개(샤드)가 되었고, Distributed Map의 이점(4만 개 이상, 자식 실행 분리)이
 * 해당되지 않는다. 일반 Map은 실행 이력이 한 화면에 남아 어느 샤드가 어디서 멈췄는지
 * 바로 보인다.
 */
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as sfn from 'aws-cdk-lib/aws-stepfunctions'
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import { CollectionConfig } from './config'

export interface OrchestrationStackProps extends StackProps {
  vpc: ec2.Vpc
  workerSg: ec2.SecurityGroup
  cluster: ecs.Cluster
  workerTaskDefinitions: ecs.FargateTaskDefinition[]
  collection: CollectionConfig
}

export class OrchestrationStack extends Stack {
  readonly stateMachine: sfn.StateMachine

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props)

    const { collection, workerTaskDefinitions } = props
    if (workerTaskDefinitions.length !== collection.totalShards) {
      throw new Error(
        `워커 태스크 정의가 ${workerTaskDefinitions.length}개인데 샤드는 ${collection.totalShards}개다`,
      )
    }

    /*
     * 샤드마다 태스크 정의가 다르므로(BASE_URL·LOAD_CONTROL_URL이 다르다) Map의
     * 반복 안에서 인덱스로 고를 수가 없다 — RunTask의 태스크 정의는 상태 기계
     * 정의 시점에 고정된다. 그래서 샤드별 브랜치를 만들어 Parallel로 편다.
     *
     * 샤드가 많아지면 정의가 길어지지만, 대안(태스크 정의를 하나로 합치고 환경변수를
     * 실행 시점에 override)은 "어느 샤드가 어떤 설정으로 돌았는가"를 태스크 정의가
     * 아니라 실행 입력에 숨긴다. 재현성 쪽이 무겁다.
     */
    const branches = workerTaskDefinitions.map((taskDefinition, index) => {
      const pad = String(index).padStart(2, '0')

      const run = new tasks.EcsRunTask(this, `Shard${pad}`, {
        integrationPattern: sfn.IntegrationPattern.RUN_JOB, // .sync — 끝날 때까지 붙잡는다
        cluster: props.cluster,
        taskDefinition,
        launchTarget: new tasks.EcsFargateLaunchTarget(),
        subnets: { subnetGroupName: 'measure' },
        securityGroups: [props.workerSg],
        assignPublicIp: false,
        /*
         * 기본 타임아웃(없음)에 기대면 태스크가 매달린 채로 영원히 과금되므로
         * 상한을 준다 — 넉넉하되 무한하지는 않게.
         *
         * 72시간이었다. grid-v1 본수집이 그 값에 죽었다(2026-08-17 01:26): high
         * 샤드는 비콘 미도착 재시도로 다른 샤드의 2배(셀당 5~7분, stale 셀 42분)가
         * 걸려 41시간 예상이 78시간이 되었고, 480/520·446/520에서 잘렸다. 상한은
         * 가장 느린 샤드의 실측 × 여유로 잡는다. 남은 셀은 scripts/resume-shards.sh로.
         */
        taskTimeout: sfn.Timeout.duration(Duration.hours(120)),
        resultPath: sfn.JsonPath.DISCARD,
      })

      /*
       * 재시도는 인프라성 실패에만 건다.
       *
       * 워커가 스스로 멈추는 경우(연속 측정 실패, 배경 부하 이탈)는 재시도해도
       * 같은 이유로 다시 멈춘다 — 그건 사람이 봐야 하는 신호다. 반면 Fargate 용량
       * 부족이나 이미지 풀 실패는 다시 시도하면 되는 종류다. 셀 단위 체크포인트가
       * 있으므로 재시도는 이미 잰 셀을 다시 재지 않는다.
       */
      /*
       * `States.TaskFailed`를 넣으면 안 된다. RUN_JOB 통합에서 컨테이너가 0이 아닌
       * 코드로 끝나면 전부 이 오류로 오므로, 워커의 **의도된** 자진 정지까지 재시도
       * 대상이 된다 — 위 문단이 하지 말자고 적어 둔 바로 그것이다.
       *
       * slice-b2에서 그렇게 됐다(2026-08-09). high 샤드가 부하 이탈로 스스로 멈췄고,
       * 재시도가 3회 더 띄워 4샤드 × 40분을 태운 뒤 같은 이유로 죽었다.
       *
       * 그 결과 감수하는 공백: **일시적 이미지 풀 실패도 재시도되지 않는다.**
       * CannotPullContainerError는 RunTask 성공 후 태스크가 STOPPED로 끝나는
       * 경로라 States.TaskFailed로 도착하기 때문이다. ECR 순단 한 번이 수집
       * 전체를 세울 수 있다 — 자진 정지와 풀 실패를 가르려면 워커가 종료 코드로
       * 신호하고 여기서 Choice로 갈라야 하는데, 그 복잡도 대신 "멈추면 사람이
       * 보고 재개한다"를 선택했다. 체크포인트 덕에 재개 비용은 캘리브레이션뿐이다.
       */
      run.addRetry({
        errors: ['ECS.AmazonECSException', 'ECS.LimitExceededException'],
        interval: Duration.minutes(2),
        maxAttempts: 3,
        backoffRate: 2,
      })

      return run
    })

    const fanOut = new sfn.Parallel(this, 'AllShards', {
      comment: `샤드 ${collection.totalShards}개 동시 실행`,
      resultPath: sfn.JsonPath.DISCARD,
    })
    for (const b of branches) fanOut.branch(b)

    /*
     * Parallel은 브랜치 하나가 실패하면 전체를 실패시킨다. 그대로 둔다 —
     * 샤드 하나가 죽은 채 "수집 완료"로 끝나면, 그 부하 수준의 셀이 통째로 빈
     * 데이터셋을 완성본으로 착각하게 된다. 어느 샤드가 왜 멈췄는지는 실행 이력에 남고,
     * 고친 뒤 같은 실험 이름으로 다시 돌리면 체크포인트가 남은 셀만 잰다.
     *
     * 알고 감수하는 대가: 실패 순간 **건강한 나머지 브랜치도 셀 중간에서
     * 취소된다**(RUN_JOB 태스크 중단). 체크포인트가 셀 단위라 데이터 파손은
     * 없지만, 재개 시 전 샤드가 재캘리브레이션을 치르고 진행 중이던 셀은 다시
     * 잰다 — 샤드당 15~20분씩의 비용이다.
     */
    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      // shard-stack의 Logs와 같은 정책 — 지정하지 않으면 RETAIN이라 스택을
      // 지워도 로그 그룹이 남아 쌓인다.
      removalPolicy: RemovalPolicy.DESTROY,
    })

    this.stateMachine = new sfn.StateMachine(this, 'Collect', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        fanOut.next(new sfn.Succeed(this, 'CollectionComplete')),
      ),
      timeout: Duration.hours(130),
      tracingEnabled: false,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    })

    /*
     * 실행이 비정상 종료되면 SUT·부하 서비스를 0으로 축소한다.
     *
     * 워커는 RunTask라 실행과 함께 끝나지만, SUT·부하는 desiredCount 고정 서비스라
     * 실행이 죽어도 계속 떠서 과금된다 — grid-v1 1차(17:53)와 2차(22:34) 실패에서
     * 각각 4시간 17분 × 40태스크, 발견까지의 시간만큼 유휴 과금이 났다. 41시간짜리
     * 무인 실행에서 "사람이 보고 끈다"는 방어선이 아니다.
     *
     * 서비스 이름을 나열하지 않고 클러스터의 전 서비스를 축소한다 — 샤드 수가
     * 바뀌어도 이 코드는 그대로다. 성공(SUCCEEDED)은 건드리지 않는다: 수집 완료 후
     * 검증 트래픽을 보낼 수 있어야 하고, 종료는 어차피 스택 삭제로 한다.
     */
    const scaleDown = new lambda.Function(this, 'ScaleDownOnFailure', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.minutes(5),
      code: lambda.Code.fromInline(`
const { ECSClient, ListServicesCommand, UpdateServiceCommand } = require('@aws-sdk/client-ecs')
const ecs = new ECSClient({})
exports.handler = async (event) => {
  const cluster = process.env.CLUSTER_ARN
  const status = event?.detail?.status
  console.log('실행 종료 감지', status, event?.detail?.executionArn)
  let token
  const services = []
  do {
    const page = await ecs.send(new ListServicesCommand({ cluster, nextToken: token, maxResults: 100 }))
    services.push(...(page.serviceArns ?? []))
    token = page.nextToken
  } while (token)
  for (const svc of services) {
    await ecs.send(new UpdateServiceCommand({ cluster, service: svc, desiredCount: 0 }))
  }
  console.log(\`서비스 \${services.length}개를 0으로 축소\`)
}
`),
      environment: { CLUSTER_ARN: props.cluster.clusterArn },
    })
    scaleDown.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListServices', 'ecs:UpdateService'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
      }),
    )

    new events.Rule(this, 'OnExecutionFailure', {
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          status: ['FAILED', 'TIMED_OUT', 'ABORTED'],
          stateMachineArn: [this.stateMachine.stateMachineArn],
        },
      },
      targets: [new targets.LambdaFunction(scaleDown)],
    })

    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn })
    new CfnOutput(this, 'StartCommand', {
      value:
        `aws stepfunctions start-execution --state-machine-arn ` +
        `${this.stateMachine.stateMachineArn} --name ${collection.experiment}-$(date +%Y%m%d-%H%M%S)`,
    })
  }
}
