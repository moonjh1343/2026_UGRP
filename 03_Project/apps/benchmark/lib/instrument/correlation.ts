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

  // --- 4단계: 결정 계층 ---
  /** 적용할 정책 이름. 워커가 요청마다 지정해 실험군을 가른다 */
  policy: 'x-policy',
  /** 모드 강제 지정 — factorial 수집에서 정책을 우회한다 */
  forceMode: 'x-render-mode',
  /** 결정 사유 (policy|forced|single|bot|circuit|infeasible|margin|session-cap|explore) */
  decisionReason: 'x-decision-reason',
  /** 1·2위 예측 차 — τ와 비교된 값 */
  decisionMargin: 'x-decision-margin',
  /** 추론 시간(µs). 4단계 합격 기준 < 2000 */
  policyUs: 'x-policy-us',
  /** 필드 무작위화 성향 점수 — 엣지가 싣는다. 오프폴리시 평가의 분모다 */
  propensity: 'x-ugrp-propensity',

  /*
   * 조건 주입 — 측정 워커가 **실제로 건 조건**을 알려준다.
   *
   * CDP의 Emulation/Network 스로틀링은 navigator.connection과 Client Hints를
   * 바꾸지 않는다. 워커가 4배 CPU 스로틀·3G를 걸어도 서버에는 4g·고사양으로 보인다.
   * 이걸 그대로 두면 랩 데이터의 기기·네트워크 피처가 전부 상수가 되어
   * 모델이 배우려는 축 자체가 사라진다.
   */
  cellDeviceTier: 'x-cell-device-tier',
  cellEffectiveType: 'x-cell-effective-type',
  cellRttMs: 'x-cell-rtt-ms',
  cellDownlink: 'x-cell-downlink',
} as const

export const COOKIE = {
  sessionId: '__sid',
  /** 세션 프로파일 — 콜드 스타트 이후 정밀 피처 (제안서 §3.4) */
  profile: '__prof',
  /** 세션·라우트별 확정 모드와 전환 횟수 — 전환 상한 강제 (제안서 §3.5) */
  decision: '__dec',
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
  /** 결정 계층 추론 시간. dur이 4단계 합격 기준(< 2ms)의 측정값이다 */
  policy: 'policy',
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
