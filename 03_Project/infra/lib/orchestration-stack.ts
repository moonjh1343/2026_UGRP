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
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
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
         * 41시간짜리 일이다. 기본 타임아웃(없음)에 기대면 태스크가 매달린 채로
         * 영원히 과금되므로 상한을 준다 — 넉넉하되 무한하지는 않게.
         */
        taskTimeout: sfn.Timeout.duration(Duration.hours(72)),
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
      run.addRetry({
        errors: ['ECS.AmazonECSException', 'ECS.LimitExceededException', 'States.TaskFailed'],
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
     */
    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    })

    this.stateMachine = new sfn.StateMachine(this, 'Collect', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        fanOut.next(new sfn.Succeed(this, 'CollectionComplete')),
      ),
      timeout: Duration.hours(96),
      tracingEnabled: false,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    })

    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn })
    new CfnOutput(this, 'StartCommand', {
      value:
        `aws stepfunctions start-execution --state-machine-arn ` +
        `${this.stateMachine.stateMachineArn} --name ${collection.experiment}-$(date +%Y%m%d-%H%M%S)`,
    })
  }
}
