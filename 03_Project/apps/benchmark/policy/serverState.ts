/**
 * 서버 상태 스냅샷 캐시 (제안서 §6.7, 설계 문서 §7).
 *
 * **절대 await 하지 않는다.** 요청 경로에서 /api/internal/metrics를 기다리면
 * 그 왕복이 통째로 TTFB에 얹히고, 측정하려는 개선폭(수 ms)보다 큰 오염이 된다.
 * 갱신은 백그라운드로 던지고 요청은 항상 캐시된 값을 즉시 받는다.
 *
 * 그래서 이 값은 **의도적으로 최대 30초 스테일**이다. 서버 부하는 초 단위로
 * 출렁이지 않으므로 신선도보다 왕복 비용이 비싸다. 대신 스냅샷 나이를 피처로
 * 함께 내보내 사후 분석에서 스테일 영향을 분리할 수 있게 한다.
 *
 * 상태를 서버(Node)에서 읽어야 하는 이유: 이벤트 루프 지연·CPU·인플라이트는
 * 렌더가 실제로 도는 프로세스의 값이고, 엣지 아이솔레이트에는 그 정보가 없다.
 */
import { SERVER_STATE_TTL_MS } from './config'

/** /api/internal/metrics의 응답 계약. 앱 모듈을 임포트하지 않고 형태만 고정한다. */
export type RemoteSnapshot = {
  cpuPct: number
  eventLoopP95Ms: number
  inflight: number
  cacheHitRate: number
  routeRps: Record<string, number>
  guardrails?: { hydrationErrorRate: number; errorRate5xx: number }
  ts: number
}

const EMPTY: RemoteSnapshot = {
  cpuPct: 0,
  eventLoopP95Ms: 0,
  inflight: 0,
  cacheHitRate: 0,
  routeRps: {},
  guardrails: { hydrationErrorRate: 0, errorRate5xx: 0 },
  ts: 0,
}

type Cache = { snap: RemoteSnapshot; fetchedAt: number; refreshingSince: number }

/**
 * 모듈 스코프에 두는 것으로 충분하다 — 엣지 아이솔레이트는 재사용되고,
 * 새 아이솔레이트가 뜨면 첫 요청만 EMPTY를 보고 곧바로 채워진다.
 * 첫 요청이 0을 보는 것은 제안서 §3.4의 "첫 요청은 보수적으로 기본 모드"와 같은 상황이다.
 */
const cache: Cache = { snap: EMPTY, fetchedAt: 0, refreshingSince: 0 }

/** 갱신 fetch의 상한. 이 이상 걸리면 끊는다 — 스테일 값으로 계속 가는 것이 낫다. */
const REFRESH_TIMEOUT_MS = 5_000
/**
 * refreshingSince가 이보다 오래됐으면 진행 중 표시를 무시한다. Lambda@Edge는 응답 후
 * 실행을 동결하는데, 동결 중 소켓이 회수되어 Promise가 영영 settle하지 않으면
 * finally가 돌지 않는다 — 플래그가 boolean이면 그 아이솔레이트는 영원히 갱신을
 * 예약하지 않고 서버 상태 피처가 무오류로 동결된다("영원히 0" 사고의 남은 변종).
 */
const REFRESH_STUCK_MS = 30_000

/** 지금 캐시된 값. 절대 블로킹하지 않는다. */
export function cachedSnapshot(): { snap: RemoteSnapshot; ageMs: number; warm: boolean } {
  const ageMs = cache.fetchedAt === 0 ? Infinity : Date.now() - cache.fetchedAt
  return { snap: cache.snap, ageMs, warm: cache.fetchedAt !== 0 }
}

/**
 * TTL이 지났으면 백그라운드 갱신을 예약한다. 반환된 Promise는 `event.waitUntil`에
 * 넘겨야 한다 — 미들웨어가 응답을 반환한 뒤 부유 Promise가 취소되면 캐시가 영영 비고,
 * 모든 서버 상태 피처가 0으로 굳는다.
 */
export function scheduleRefresh(origin: string): Promise<void> | null {
  const now = Date.now()
  const ageMs = cache.fetchedAt === 0 ? Infinity : now - cache.fetchedAt
  const refreshing = cache.refreshingSince !== 0 && now - cache.refreshingSince < REFRESH_STUCK_MS
  if (refreshing || ageMs < SERVER_STATE_TTL_MS) return null

  cache.refreshingSince = now
  return fetch(`${origin}/api/internal/metrics`, {
    headers: { 'x-policy-internal': '1' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })
    .then((r) => (r.ok ? (r.json() as Promise<RemoteSnapshot>) : null))
    .then((snap) => {
      if (snap) {
        cache.snap = snap
        cache.fetchedAt = Date.now()
      }
    })
    .catch(() => {
      /* 상태 조회 실패는 결정을 막지 않는다 — 스테일 값으로 계속 간다 */
    })
    .finally(() => {
      cache.refreshingSince = 0
    })
}
