/**
 * 결정 계층의 타입 정의.
 *
 * 이 디렉토리는 **앱 코드에 의존하지 않는다.** `app/`·`components/`를 임포트하면
 * 정책을 갈아끼울 때 앱이 함께 흔들리고, 4단계 합격 기준("정책 교체가 앱 코드에
 * 영향을 주지 않는가")이 성립하지 않는다. 허용되는 의존은 `lib/modes`,
 * `lib/routes`처럼 **정책과 앱이 공유하는 계약**뿐이다. (`npm run check:policy`가 검사한다)
 *
 * 실제 배포에서 이 코드는 Lambda@Edge로 떨어져 나간다. 그 이식성을 지키려면
 * Node 전용 API(fs, os, perf_hooks)를 쓰지 않아야 한다 — 여기 있는 것은 전부 엣지 안전이다.
 */
import type { Mode } from '@/lib/modes'
import type { RouteType } from '@/lib/routes'

export type EffectiveType = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown'

/**
 * 제안서 §3.4의 특징 집합. 요청 시점에 **계산하지 않고 조회만** 한다 —
 * 계산 비용이 곧 TTFB 오버헤드이고, 그 오버헤드가 측정 대상을 왜곡한다.
 */
export type Features = {
  // --- 라우트/콘텐츠 (빌드 타임 정적 분석 → 룩업) ---
  routeType: RouteType
  routeKey: string
  nodeCount: number
  interactiveCount: number
  payloadKB: number
  fetchDepth: number
  fetchDelayMs: number
  personalizedRatio: number
  seoWeight: number
  /** 모드별 클라이언트 JS(KB). 단일 값으로 뭉치면 Islands의 이득이 사라진다(설계 문서 §10) */
  bundleKB: Record<Mode, number>

  // --- 클라이언트 성능 ---
  /** 1(저사양)~4(고사양). Client Hints 결측 시 UA 기반 사전 분포로 대체 */
  deviceTier: number
  deviceMemory: number
  hardwareConcurrency: number
  /** 이전 세션 RUM 요약 — 콜드 스타트에서는 null */
  prevLcpMs: number | null
  prevTbtMs: number | null

  // --- 네트워크 ---
  effectiveType: EffectiveType
  rttMs: number
  downlinkMbps: number
  saveData: boolean

  // --- 서버 상태 (의도적으로 ~30초 스테일) ---
  cpuPct: number
  eventLoopP95Ms: number
  inflight: number
  cacheHitRate: number
  /** 이 라우트의 최근 60초 요청률. §3.1.2의 missRate(ssg) = 1/max(1, rps_r·T) */
  routeRps: number
  /** 스냅샷 나이(ms). 스테일 정도 자체를 피처로 남겨야 사후 분석이 가능하다 */
  serverStateAgeMs: number
  /** 가드레일 — 서킷 브레이커 판정 */
  hydrationErrorRate: number
  errorRate5xx: number

  // --- 컨텍스트 ---
  isBot: boolean
  isRepeatVisit: boolean
  /** 측정 워커가 조건을 헤더로 주입했는가 — 실험 셀에서는 true */
  conditionInjected: boolean
}

/**
 * 결정 사유. 폴백·오버라이드가 얼마나 자주 발동했는지 집계해야
 * 정책 비교 결과를 해석할 수 있다(설계 문서 §9).
 */
export type DecisionReason =
  | 'policy' // 정책 결과 그대로
  | 'forced' // 워커가 경로/헤더로 직접 지정 (factorial 수집)
  | 'single' // |M(x)| = 1 — 선택의 여지 없음
  | 'bot' // 크롤러 UA → SSR 고정
  | 'circuit' // 서킷 브레이커 개방
  | 'infeasible' // 정책이 M(x) 밖의 모드를 골랐다
  | 'margin' // 1·2위 차 < τ → 전환하지 않음
  | 'session-cap' // 세션당 전환 상한 도달

export type Decision = {
  /** 실제 적용할 모드 — 항상 M(x)의 원소 */
  mode: Mode
  policy: string
  reason: DecisionReason
  /** 정책이 원래 고른 모드. reason ≠ 'policy'이면 mode와 다를 수 있다 */
  intended: Mode
  candidates: Mode[]
  /** 서러게이트만 채운다. Ĵ(x, m), 낮을수록 좋음 */
  scores: Partial<Record<Mode, number>> | null
  /** 1·2위 차이. τ와 비교되는 값이며, 그 자체가 분석 대상이다 */
  margin: number | null
  /** 추론 시간(µs). 4단계 합격 기준은 < 2ms */
  inferenceUs: number
}

/**
 * 정책. 후보 밖의 모드를 반환해도 된다 — 실행 가능성 강제는 `decide()`가 하고,
 * 그 폴백 발생 자체를 기록한다. 정책이 스스로 감추면 집계가 불가능해진다.
 */
export type Policy = (
  f: Features,
  cands: Mode[],
) => { mode: Mode; scores?: Partial<Record<Mode, number>> }
