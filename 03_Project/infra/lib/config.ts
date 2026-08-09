/**
 * 실험 인프라 설정.
 *
 * 여기 있는 값은 **실험 조건이지 배포 취향이 아니다.** 그리드와 마찬가지로 버전
 * 관리되며, 바꾸면 그 이후 수집분은 이전과 같은 데이터셋이 아니다.
 */

/** 오리진 리전. 제안서가 ap-northeast-2로 고정했다 — 실제 RTT 측정의 기준점이다. */
export const REGION = 'ap-northeast-2'

/**
 * **단일 AZ에 모든 태스크를 둔다.**
 *
 * 네트워크 조건은 CDP로 에뮬레이션하지만, 그 아래에 깔리는 실제 RTT는 노이즈
 * 바닥이다. 워커와 SUT가 AZ를 넘으면 0.5~1ms가 더해지고 그 편차가 매 측정에
 * 실린다. 가용성보다 측정 안정성이 우선인 실험 인프라라 AZ를 하나로 고정한다.
 * 부수적으로 인터페이스 VPC 엔드포인트 비용도 절반이 된다.
 */
export const MAX_AZS = 1

/** SUT가 듣는 포트. Next.js 기본값. */
export const SUT_PORT = 3000

/**
 * 부하 생성기 제어 포트.
 *
 * 워커가 여기로 VU 수를 지시하고 상태를 읽는다. **제어 평면이지 데이터 평면이 아니다** —
 * 부하 트래픽은 부하 생성기 → SUT 방향이고, 워커로는 흐르지 않는다.
 */
export const LOAD_CONTROL_PORT = 4000

/** 서비스 디스커버리 네임스페이스. 샤드마다 sut-<i>.<네임스페이스>로 붙는다. */
export const NAMESPACE = 'ugrp.local'

/**
 * 태스크 크기.
 *
 * SUT의 cpu/memory는 **실험 변수**다(제안서 §5.1). 바꾸면 부하 캘리브레이션의
 * VU→CPU% 대응이 통째로 달라지므로, 캘리브레이션과 함께 실험 메타데이터에 남는다.
 */
export const TASK_SIZE = {
  /** SUT — 렌더링이 CPU 바운드라 여기가 병목이다. */
  sut: { cpu: 2048, memoryMiB: 4096 },
  /** Playwright 워커 — 브라우저가 메모리를 먹는다. */
  worker: { cpu: 2048, memoryMiB: 4096 },
  /** k6 부하 생성기 — VU 수만큼 고루틴이라 CPU보다 메모리가 먼저 는다. */
  load: { cpu: 1024, memoryMiB: 2048 },
} as const

/**
 * 컨테이너 이미지 다이제스트.
 *
 * **`:latest` 태그는 실격이다**(재현성 요구사항). 태그는 같은 이름이 나중에 다른
 * 바이트를 가리킬 수 있어서, "그때 뭘 돌렸는가"가 기록되지 않는다. sha256으로만
 * 참조한다.
 *
 * 값은 이미지를 빌드해 ECR에 올린 뒤 `scripts/push-images.sh`가 채운다.
 * 비어 있으면 합성 단계에서 막는다 — 태그로 대충 넘어갈 여지를 두지 않는다.
 */
export interface ImageDigests {
  sut: string
  worker: string
  load: string
}

export function requireDigests(d: Partial<ImageDigests>, stage: string): ImageDigests {
  const missing = (['sut', 'worker', 'load'] as const).filter((k) => !d[k])
  if (missing.length) {
    throw new Error(
      `[${stage}] 이미지 다이제스트가 없다: ${missing.join(', ')}\n` +
        '  scripts/push-images.sh로 빌드·푸시한 뒤 cdk.json의 ugrp:digests에 넣는다.\n' +
        '  태그(:latest 포함)로 대체하지 말 것 — 같은 태그가 나중에 다른 이미지를 가리키면\n' +
        '  그 실험은 재현되지 않는다.',
    )
  }
  for (const [k, v] of Object.entries(d)) {
    if (v && !v.startsWith('sha256:')) {
      throw new Error(`[${stage}] ${k} 다이제스트가 sha256:로 시작하지 않는다: ${v}`)
    }
  }
  return d as ImageDigests
}

/**
 * 수집 파라미터. 워커 컨테이너에 환경변수로 넘어가고, `workers/lib/shard.mjs`가
 * 같은 값으로 자기 몫을 계산한다.
 */
export interface CollectionConfig {
  /** 스택 이름 접두사. 인프라를 가리킨다. */
  experiment: string
  /**
   * 데이터 네임스페이스 — S3 프리픽스와 DynamoDB 파티션 키(`run.mjs`의 `--name`).
   *
   * **`experiment`와 분리해 둔다.** 붙여 두면 슬라이스를 따로 모으려고 이름을 바꿀 때
   * VPC와 결과 버킷까지 새로 생긴다. 반대로 이름을 공유하면 슬라이스 행과 본 수집 행이
   * 한 네임스페이스에 섞이는데, 그 사이에 이미지가 바뀌면(우리는 이미 네 번 바꿨다)
   * 서로 다른 빌드의 행이 한 데이터셋에 남는다.
   */
  runName: string
  reps: number
  totalShards: number
  /** 조건 순서·샤드 배치 시드. 실험 메타데이터에 기록된다. */
  seed: string
  /**
   * 슬라이스 필터. 워커 command에 그대로 붙는다.
   *
   * 그리드를 좁히는 것은 **실험 정의**이므로 ad-hoc 인자가 아니라 컨텍스트로 받아
   * cdk.json에 커밋한다(재현성 요구사항: 조건 그리드는 버전 관리되는 코드에 둔다).
   */
  filters: string[]
}

export const DEFAULT_COLLECTION: CollectionConfig = {
  experiment: 'grid-v1',
  runName: 'grid-v1',
  reps: 30,
  totalShards: 20,
  seed: 'ugrp-2026',
  filters: [],
}

/** `ugrp:filters`로 줄 수 있는 축. `run.mjs`의 플래그 이름과 같다. */
const FILTER_KEYS = ['devices', 'networks', 'types', 'routes', 'modes', 'cache'] as const

/**
 * 슬라이스 필터를 command 플래그로 바꾼다.
 *
 * **`loads`는 받지 않는다.** 부하 축은 샤드 배정이 담당한다(샤드 하나가 부하 수준
 * 하나). `run.mjs`는 샤드 플래그와 `--loads`를 함께 받으면 어느 쪽이 이기는지
 * 모호해지므로 거부하는데, 그 거부가 태스크 시작 시점에 일어나면 배포는 성공한 뒤다.
 * 여기서 미리 막는다.
 */
export function parseFilters(rawInput: unknown, stage: string): string[] {
  if (rawInput == null) return []
  // cdk.json의 context에 객체로 넣으면 객체로, `-c ugrp:filters={...}`로 주면 문자열로
  // 온다 — ugrp:digests와 같은 사정이다.
  let raw = rawInput
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new Error(`[${stage}] ugrp:filters 를 JSON으로 읽을 수 없다: ${raw}`)
    }
  }
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new Error(`[${stage}] ugrp:filters 는 객체여야 한다 — 예: '{"types":"content,form"}'`)
  }
  const out: string[] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'loads') {
      throw new Error(
        `[${stage}] ugrp:filters 에 loads 를 넣을 수 없다 — 부하 축은 샤드 배정이 담당한다.\n` +
          '  샤드 하나가 부하 수준 하나만 맡으므로, 부하를 좁히려면 shardCount 를 줄이는 것이\n' +
          '  아니라 수집을 나눠 돌려야 한다(shardCount 최소는 부하 수준 수다).',
      )
    }
    if (!(FILTER_KEYS as readonly string[]).includes(k)) {
      throw new Error(
        `[${stage}] ugrp:filters 의 '${k}' 는 알 수 없는 축이다. 가능: ${FILTER_KEYS.join(', ')}`,
      )
    }
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`[${stage}] ugrp:filters.${k} 는 비어 있지 않은 문자열이어야 한다`)
    }
    out.push(`--${k}`, v)
  }
  return out
}

/** 부하 수준 — grid.mjs의 LOADS와 같은 순서여야 한다. */
export const LOADS = ['idle', 'low', 'mid', 'high'] as const
export type Load = (typeof LOADS)[number]

/**
 * 샤드 수 검증.
 *
 * **샤드 하나는 부하 수준 하나만 맡는다**(`workers/lib/shard.mjs`의
 * `allocateShardsByLoad`). 부하는 SUT 전역 조건이라 한 샤드가 두 수준을 오가면
 * 전환 안정화 구간이 측정에 섞이기 때문이다. 따라서 샤드 수는 부하 수준 수보다
 * 적을 수 없다.
 *
 * 이 검사가 없으면 `-c ugrp:shardCount=1`이 **합성도 배포도 성공한 뒤 워커가
 * 시작하자마자 죽는다** — 태스크 정의에 박히는 `--shard-count 1`을 shard.mjs가
 * 거부한다. 1샤드 검증 배포에서 실제로 그렇게 됐다(2026-08-09).
 * 다이제스트와 같은 이유로 합성 단계에서 막는다: 배포되고 나서 드러나는 오류는
 * 이미 돈과 시간을 쓴 뒤다.
 */
export function requireShardCount(n: number, stage: string): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`[${stage}] ugrp:shardCount 가 양의 정수가 아니다: ${n}`)
  }
  if (n < LOADS.length) {
    throw new Error(
      `[${stage}] 샤드 ${n}개로는 부하 수준 ${LOADS.length}개(${LOADS.join('·')})를 채우지 못한다.\n` +
        '  샤드 하나가 부하 수준 하나만 맡는 규칙(workers/lib/shard.mjs) 때문에\n' +
        `  최소 ${LOADS.length}샤드가 필요하다. 더 적게 배포하면 워커가 시작 시 종료한다.`,
    )
  }
  return n
}
