/**
 * S3 + DynamoDB 체크포인트. `lib/checkpoint.mjs`의 클라우드 판이다.
 *
 * 로컬에서는 JSONL 두 벌(results/done)이 이 역할을 한다. AWS에서는 그럴 수 없다 —
 * Fargate 태스크에는 남는 디스크가 없어서, 컨테이너가 죽으면 파일도 함께 사라진다.
 * 41시간짜리 실행에서 그건 곧 데이터 손실이다.
 *
 *   S3        측정 레코드. 샤드마다 자기 프리픽스에만 쓰므로 경합이 없다.
 *   DynamoDB  완료된 셀. 로컬 done.jsonl이 하던 일이다.
 *
 * **쓰는 순서가 중요하다: S3 먼저, DynamoDB 나중.** 반대로 하면 "완료 표시는
 * 됐는데 결과가 없는" 셀이 생기고, 재개해도 건너뛰므로 영영 비어 있다. 지금 순서에서
 * 중간에 죽으면 결과만 남고 완료 표시가 없어 그 셀을 다시 잰다 — 같은 (셀, 반복)이
 * 두 벌 생기지만, 학습 쪽 `io.load_runs()`가 최신만 남기고 걸러낸다.
 *
 * 인터페이스는 로컬 Checkpoint와 같다. run.mjs가 분기하지 않는다.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'

/**
 * S3 키에 쓸 수 있게 셀 id를 다듬는다.
 *
 * cellId에는 `|`와 `/`가 들어간다(`n/a`의 슬래시). 슬래시를 그대로 두면 S3에서
 * 디렉터리 구분자가 되어, 캐시 축이 없는 셀만 프리픽스가 한 단계 깊어진다.
 */
export function safeKey(cellId) {
  return cellId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 재시도. 41시간 실행에서 일시적 오류로 죽지 않게 한다. */
const MAX_ATTEMPTS = 8

export class CloudCheckpoint {
  /**
   * @param opts.bucket S3 버킷
   * @param opts.table DynamoDB 테이블
   * @param opts.experiment 실험 이름 — DynamoDB의 파티션 키이자 S3 프리픽스
   * @param opts.shardIndex 샤드 번호. S3 프리픽스를 갈라 샤드 간 경합을 없앤다
   * @param opts.s3/opts.ddb 테스트용 주입구
   */
  constructor({ bucket, table, experiment, shardIndex = 0, region, s3, ddb }) {
    this.bucket = bucket
    this.table = table
    this.experiment = experiment
    this.shard = String(shardIndex).padStart(2, '0')
    this.s3 = s3 ?? new S3Client({ region, maxAttempts: MAX_ATTEMPTS })
    this.ddb = ddb ?? new DynamoDBClient({ region, maxAttempts: MAX_ATTEMPTS })
    this.done = new Set()
    /** 셀 단위 버퍼. 셀이 끝날 때 한 번에 올린다 — 행마다 올리면 셀당 30객체가 된다. */
    this.buffer = []
  }

  /** `#meta`는 셀 id가 될 수 없는 값이라 메타데이터 항목의 정렬 키로 안전하다. */
  get metaKey() {
    return '#meta'
  }

  async open(meta) {
    // ── 완료된 셀 목록 ────────────────────────────────────────────────────
    // 실험 전체를 읽는다(샤드별이 아니라). 셀은 정확히 한 샤드에만 속하므로 남의
    // 몫이 섞여도 무해하고, 샤드 계획이 바뀌었을 때 이미 잰 셀을 다시 재지 않는다.
    let ExclusiveStartKey
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'experiment = :e',
          ExpressionAttributeValues: { ':e': { S: this.experiment } },
          ProjectionExpression: 'cellId',
          ExclusiveStartKey,
        }),
      )
      for (const item of res.Items ?? []) {
        const id = item.cellId?.S
        // `#`로 시작하는 정렬 키는 메타데이터·캘리브레이션이지 셀이 아니다.
        // 걸러내지 않으면 완료 셀 수가 부풀고, 재개 로그가 실제와 어긋난다.
        if (id && !id.startsWith('#')) this.done.add(id)
      }
      ExclusiveStartKey = res.LastEvaluatedKey
    } while (ExclusiveStartKey)

    // ── 실험 메타데이터 ───────────────────────────────────────────────────
    const existing = await this.ddb.send(
      new GetItemCommand({
        TableName: this.table,
        Key: { experiment: { S: this.experiment }, cellId: { S: this.metaKey } },
      }),
    )

    if (existing.Item?.meta?.S) {
      /*
       * 메타데이터는 **덮어쓰지 않는다.** 재개인데 환경이 바뀌었다면(브라우저 업데이트,
       * 앱 재빌드) 앞뒤 데이터를 같은 데이터셋으로 볼 수 없다. 덮어쓰면 그 사실이 사라진다.
       * 로컬 Checkpoint와 같은 규칙이다.
       */
      const prev = JSON.parse(existing.Item.meta.S)
      const drift = []
      if (prev.env?.browser?.version !== meta.env?.browser?.version) drift.push('브라우저')
      if (prev.env?.next !== meta.env?.next) drift.push('Next.js')
      if (prev.env?.node !== meta.env?.node) drift.push('Node')
      if (prev.seeds?.order !== meta.seeds?.order) drift.push('순서 시드')
      return { resumed: true, doneCount: this.done.size, drift }
    }

    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          experiment: { S: this.experiment },
          cellId: { S: this.metaKey },
          meta: { S: JSON.stringify(meta) },
        },
        // 두 샤드가 동시에 시작해도 먼저 쓴 쪽이 이긴다. 나중 쪽은 조건 실패를
        // 받고 그냥 재개로 넘어간다 — 같은 메타데이터이므로 손실이 없다.
        ConditionExpression: 'attribute_not_exists(cellId)',
      }),
    ).catch((err) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err
    })

    /*
     * 메타데이터를 S3에도 둔다. DynamoDB 항목만으로는 `aws s3 sync`로 받은 데이터에
     * 환경 기록이 딸려오지 않는다 — 브라우저·Node·Next 버전을 모든 실험 레코드에
     * 남긴다는 재현성 요구사항이 데이터와 분리되면 지켜지지 않는 것과 같다.
     * 동기화하면 `runs/<실험>/experiment.json`으로 떨어져 로컬 실행과 같은 자리가 된다.
     */
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `experiment=${this.experiment}/experiment.json`,
        Body: JSON.stringify(meta, null, 2) + '\n',
        ContentType: 'application/json',
      }),
    )

    return { resumed: false, doneCount: 0, drift: [] }
  }

  has(cellId) {
    return this.done.has(cellId)
  }

  /** 버퍼에만 쌓는다. 실제 업로드는 complete()에서 한 번에. */
  async record(row) {
    this.buffer.push(row)
  }

  /**
   * S3 키.
   *
   * Hive 스타일 프리픽스라 Glue/Athena가 파티션으로 인식한다(제안서 §5.4의
   * "날짜와 실험 id로 파티션"). 날짜가 키에 들어가므로, 셀을 다른 날 다시 재면
   * 다른 파티션에 남는다 — 이전 시도를 지우지 않고 둘 다 보존한다. 어느 쪽을 쓸지는
   * 학습 쪽에서 (셀, 반복) 최신 우선으로 고른다.
   */
  keyFor(cellId, date = new Date()) {
    const dt = date.toISOString().slice(0, 10)
    return `experiment=${this.experiment}/dt=${dt}/shard=${this.shard}/${safeKey(cellId)}.jsonl`
  }

  async complete(cellId, summary) {
    const rows = this.buffer
    this.buffer = []

    if (rows.length) {
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(cellId),
          Body: body,
          ContentType: 'application/x-ndjson',
        }),
      )
    }

    // S3가 성공한 뒤에만 완료 표시. 순서가 뒤집히면 결과 없는 셀이 영구히 건너뛰어진다.
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          experiment: { S: this.experiment },
          cellId: { S: cellId },
          shard: { S: this.shard },
          rows: { N: String(rows.length) },
          completedAt: { S: new Date().toISOString() },
          summary: { S: JSON.stringify(summary ?? {}) },
        },
      }),
    )
    this.done.add(cellId)
  }

  /**
   * 실행 시점에 새로 잡은 캘리브레이션. 실험 메타데이터를 덮어쓰지 않는 규칙 때문에
   * 별도 항목으로 둔다 — 샤드마다 값이 다르므로 샤드별 키다.
   */
  async recordCalibration(payload) {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          experiment: { S: this.experiment },
          cellId: { S: `#calibration#${this.shard}` },
          calibration: { S: JSON.stringify(payload) },
          at: { S: new Date().toISOString() },
        },
      }),
    )
  }

  /** 남은 버퍼를 버린다. 셀이 끝나지 않았으므로 그 행들은 어차피 쓰이지 않는다. */
  discardPending() {
    const n = this.buffer.length
    this.buffer = []
    return n
  }
}
