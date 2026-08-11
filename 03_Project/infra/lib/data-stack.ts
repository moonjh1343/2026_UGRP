/**
 * 데이터 평면.
 *
 * 샤드 20개가 동시에 쓰는 순간, 로컬의 JSONL 체크포인트가 성립하지 않는다 —
 * append-only 파일은 한 프로세스가 소유할 때만 안전하다. 두 가지로 나눈다:
 *
 *   S3        측정 레코드. 샤드마다 자기 키 프리픽스에만 쓰므로 경합이 없다.
 *   DynamoDB  셀 단위 체크포인트. 로컬 done.jsonl이 하던 역할이고,
 *             조건부 쓰기로 "이미 잰 셀을 또 재지 않는다"를 보장한다.
 *
 * 정적 분할이라 두 샤드가 같은 셀을 집는 일은 원래 없다(workers/lib/shard.mjs).
 * 그래도 조건부 쓰기를 쓰는 이유는 **재시도** 때문이다 — 태스크가 죽어 ECS가 다시
 * 띄우면 같은 샤드가 같은 셀을 다시 잰다. 그때 이미 끝난 셀은 건너뛰어야 한다.
 */
import { RemovalPolicy, Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import { Construct } from 'constructs'

export interface DataStackProps extends StackProps {
  /** 저장소 이름에 들어간다. 실험이 다르면 이미지도 다르다. */
  experiment: string
}

export class DataStack extends Stack {
  readonly results: s3.Bucket
  readonly checkpoint: dynamodb.Table
  readonly repos: { sut: ecr.Repository; worker: ecr.Repository; load: ecr.Repository }

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props)

    /*
     * 측정 결과. RETAIN인 이유는 명백하다 — 813 코어-시간을 들여 모은 데이터를
     * `cdk destroy` 한 번으로 지울 수 있게 두지 않는다.
     */
    this.results = new s3.Bucket(this, 'Results', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        // 미완료 멀티파트는 과금되면서 아무 값도 없다.
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
        // versioned 버킷에서 --requeue 재수집이 덮어쓴 구버전이 무한 축적된다 —
        // 90일이면 "실수로 덮어쓴 것을 되살릴" 기간으로 충분하다.
        { noncurrentVersionExpiration: Duration.days(90) },
      ],
    })

    /*
     * 셀 체크포인트. PK=실험, SK=셀 id.
     *
     * 온디맨드 과금인 이유: 쓰기가 셀당 한 번(수 초~수 분에 한 번)이라 프로비저닝
     * 용량을 잡을 만큼 꾸준하지도, 많지도 않다. 샤드 20개여도 초당 수 건 수준이다.
     */
    this.checkpoint = new dynamodb.Table(this, 'Checkpoint', {
      partitionKey: { name: 'experiment', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'cellId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    })

    /*
     * 이미지 저장소. imageTagMutability를 IMMUTABLE로 두어 같은 태그가 나중에 다른
     * 바이트를 가리키는 일 자체를 막는다 — 다이제스트로 참조한다는 규칙의 이중 안전장치다.
     */
    /*
     * 저장소 이름을 CDK가 짓게 두지 않는다. 서빙 오리진 스택이 **다른 스택에서**
     * 이 저장소를 이름으로 참조하는데, 생성된 이름은 스택마다 접미사가 붙어
     * 예측할 수 없다. RETAIN이라 이름 고정으로 인한 교체 문제도 없다.
     */
    const repo = (name: string, repositoryName: string) =>
      new ecr.Repository(this, name, {
        repositoryName,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.RETAIN,
        /*
         * 상한을 넉넉히 둔다. 20으로 뒀더니 다이제스트 고정과 충돌했다 — 실험
         * 기록에 남은 다이제스트의 **바이트가 만료돼**, 해시만으로는 그 실험을
         * 같은 이미지로 재실행할 수 없게 된다. 이미지당 ~500MB × 100개라야
         * 월 수 달러다. 재현성이 걸린 저장소에서는 지우지 않는 쪽이 싸다.
         */
        lifecycleRules: [{ maxImageCount: 100, description: '실험 기록에 남은 다이제스트의 바이트를 보존한다' }],
      })

    this.repos = {
      sut: repo('SutRepo', `${props.experiment}-sut`),
      worker: repo('WorkerRepo', `${props.experiment}-worker`),
      load: repo('LoadRepo', `${props.experiment}-load`),
    }

    new CfnOutput(this, 'ResultsBucket', { value: this.results.bucketName })
    new CfnOutput(this, 'CheckpointTable', { value: this.checkpoint.tableName })
    new CfnOutput(this, 'SutRepoUri', { value: this.repos.sut.repositoryUri })
    new CfnOutput(this, 'WorkerRepoUri', { value: this.repos.worker.repositoryUri })
    new CfnOutput(this, 'LoadRepoUri', { value: this.repos.load.repositoryUri })
  }
}
