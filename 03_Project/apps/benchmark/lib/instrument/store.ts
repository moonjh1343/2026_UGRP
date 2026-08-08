import type { Mode } from '@/lib/modes'

/**
 * 인메모리 레코드 저장소. 2단계 범위에서는 데이터 레이크(Kinesis→S3) 대신
 * 링 버퍼를 쓴다. 목적은 **상관 ID 조인이 실제로 성립하는지 증명**하는 것이고,
 * 영속화는 5단계에서 붙인다.
 *
 * globalThis에 매다는 이유: Next.js는 라우트 핸들러와 서버 컴포넌트를 서로 다른
 * 모듈 그래프로 번들할 수 있어, 모듈 스코프 변수가 공유되지 않을 수 있다.
 */

export type RenderRecord = {
  kind: 'render'
  /** SSG는 요청 전에 렌더되므로 요청별 cid가 없다 — 재검증 시점 레코드가 된다 */
  cid: string | null
  sid: string | null
  mode: Mode
  routeType: string
  routeKey: string
  /** 렌더 CPU 시간(µs). 배경 부하가 있으면 오염된다 — 설계 문서 §7 참조 */
  cpuUs: number
  wallMs: number
  ts: number
}

export type BeaconRecord = {
  kind: 'beacon'
  cid: string
  sid: string | null
  mode: string | null
  routeKey: string | null
  metrics: Record<string, number>
  /** LCP가 느릴 때 원인이 TTFB인지 리소스 로드인지 렌더 지연인지 분해 */
  attribution: Record<string, unknown>
  hydrationErrors: number
  ts: number
}

type Store = {
  renders: RenderRecord[]
  beacons: BeaconRecord[]
  /** 라우트별 요청 수 — 제안서 §3.1.2의 rps_r 산출용 */
  routeHits: Map<string, number[]>
  cacheStatus: { hit: number; miss: number; stale: number }
}

const LIMIT = 5000

declare global {
  // eslint-disable-next-line no-var
  var __ugrpStore: Store | undefined
}

export function store(): Store {
  if (!globalThis.__ugrpStore) {
    globalThis.__ugrpStore = {
      renders: [],
      beacons: [],
      routeHits: new Map(),
      cacheStatus: { hit: 0, miss: 0, stale: 0 },
    }
  }
  return globalThis.__ugrpStore
}

function push<T>(arr: T[], v: T) {
  arr.push(v)
  if (arr.length > LIMIT) arr.splice(0, arr.length - LIMIT)
}

export function putRender(r: RenderRecord) {
  push(store().renders, r)
  noteRouteHit(r.routeKey, r.ts)
}

export function putBeacon(b: BeaconRecord) {
  push(store().beacons, b)
}

export function noteRouteHit(routeKey: string, ts: number) {
  const s = store()
  const hits = s.routeHits.get(routeKey) ?? []
  hits.push(ts)
  // 최근 60초만 유지 — rps_r은 순간 요청률이다
  const cutoff = ts - 60_000
  while (hits.length && hits[0] < cutoff) hits.shift()
  s.routeHits.set(routeKey, hits)
}

/** 라우트별 최근 60초 요청률. 제안서 §3.1.2의 missRate 계산에 들어간다. */
export function routeRps(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, hits] of store().routeHits) out[key] = hits.length / 60
  return out
}

export function noteCacheStatus(status: string) {
  const s = store().cacheStatus
  const k = status.toLowerCase()
  if (k === 'hit') s.hit++
  else if (k === 'stale') s.stale++
  else s.miss++
}

export function cacheHitRate(): number {
  const { hit, miss, stale } = store().cacheStatus
  const total = hit + miss + stale
  return total === 0 ? 0 : hit / total
}

export function reset() {
  const s = store()
  s.renders.length = 0
  s.beacons.length = 0
  s.routeHits.clear()
  s.cacheStatus = { hit: 0, miss: 0, stale: 0 }
}
