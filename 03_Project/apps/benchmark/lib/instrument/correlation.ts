/**
 * 상관 ID 파이프라인의 이름 정의.
 *
 * 렌더 결정은 결정 계층에서, 성능 측정은 브라우저에서 일어난다.
 * 이 둘을 잇지 못하면 데이터셋이 통째로 쓸모없어진다(설계 문서 §7).
 */

export const HEADER = {
  /** 결정 계층이 발급해 앱과 클라이언트 양쪽에 전달하는 요청 식별자 */
  correlationId: 'x-correlation-id',
  /** 세션 단위 결정 캐싱·전환 상한용 (제안서 §3.5) */
  sessionId: 'x-session-id',
  /** factorial 셀 식별자 */
  expCell: 'x-exp-cell',
  /** 실제 적용된 모드 — 하드 규칙 오버라이드 확인용 */
  modeApplied: 'x-render-mode-applied',
  /** 렌더 CPU 시간(µs) */
  serverCpuUs: 'x-server-cpu-us',
  /** ISR 캐시 판정 — §3.1.2의 missRate 계산에 필수 */
  cacheStatus: 'x-cache-status',
  /** Next.js가 ISR 라우트에 붙이는 캐시 판정 (HIT/MISS/STALE) */
  nextCache: 'x-nextjs-cache',
} as const

export const COOKIE = {
  sessionId: '__sid',
  /** 세션 프로파일 — 콜드 스타트 이후 정밀 피처 (제안서 §3.4) */
  profile: '__prof',
} as const

/**
 * Server-Timing 항목 이름.
 *
 * 이 헤더를 쓰는 이유가 2단계 설계의 핵심이다. SSG·ISR 페이지는 요청 **전에**
 * 렌더되므로 HTML에 요청별 cid를 심을 수 없다. 반면 응답 헤더는 캐시된 본문에도
 * 요청마다 새로 붙고, `performance.getEntriesByType('navigation')[0].serverTiming`으로
 * 브라우저 JS에서 읽을 수 있다. 따라서 5개 모드 전부에서 동일하게 동작한다.
 */
export const TIMING = {
  correlationId: 'cid',
  sessionId: 'sid',
  mode: 'mode',
  route: 'route',
  cache: 'cache',
  render: 'render',
} as const

/** Server-Timing 값에 쓸 수 없는 문자를 제거한다. desc는 토큰 또는 quoted-string이어야 한다. */
export function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_.:\-]/g, '')
}

export function timingEntry(name: string, desc?: string, durMs?: number): string {
  const parts = [name]
  if (durMs !== undefined) parts.push(`dur=${durMs.toFixed(3)}`)
  if (desc !== undefined) parts.push(`desc="${sanitize(desc)}"`)
  return parts.join(';')
}

/** Edge 런타임과 Node 런타임 모두에서 사용 가능 */
export function newId(): string {
  return crypto.randomUUID()
}
