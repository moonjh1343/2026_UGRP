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
  experiment: string
  reps: number
  totalShards: number
  /** 조건 순서·샤드 배치 시드. 실험 메타데이터에 기록된다. */
  seed: string
}

export const DEFAULT_COLLECTION: CollectionConfig = {
  experiment: 'grid-v1',
  reps: 30,
  totalShards: 20,
  seed: 'ugrp-2026',
}

/** 부하 수준 — grid.mjs의 LOADS와 같은 순서여야 한다. */
export const LOADS = ['idle', 'low', 'mid', 'high'] as const
export type Load = (typeof LOADS)[number]
