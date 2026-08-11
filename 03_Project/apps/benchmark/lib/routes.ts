/**
 * 라우트 정의. 제안서 §3.4의 라우트 특징 + §3.1.1의 실행 가능 모드 집합.
 *
 * 라우트를 코드가 아니라 **데이터**로 다루는 것이 확장성의 핵심이다.
 * 25개를 각각 손으로 만들면 유지가 불가능하고, 유형 간 차이가
 * 의도한 축이 아닌 곳에서 생긴다.
 */
import { MODES, type Mode } from './modes'

export const ROUTE_TYPES = ['content', 'list', 'dashboard', 'form', 'personalized'] as const
export type RouteType = (typeof ROUTE_TYPES)[number]

/** 제안서 §3.1.1의 부분 개인화 임계값. 이 아래는 ISR + 클라이언트 개인화 하이브리드가 성립. */
export const THETA_P = 0.2

/** ISR 재검증 주기(ms). SSG 후보 판정과 §3.1.2의 missRate 계산에 함께 쓰인다. */
export const REVALIDATE_MS = 60_000

export type Route = {
  type: RouteType
  key: string
  /** 예상 DOM 노드 수 — 서버·클라이언트 렌더 CPU 양쪽에 영향 */
  nodeCount: number
  /** 하이드레이션 대상 위젯 수 — Islands의 이득 폭을 결정 */
  interactiveCount: number
  /** 데이터 페이로드 크기(KB) — 저대역에서 지배적 */
  payloadKB: number
  /** 순차 의존 fetch 단계 — CSR은 왕복이 누적된다 */
  fetchDepth: number
  /** 백엔드 의존성 지연(ms) — SSR·Streaming의 TTFB에 직격 */
  fetchDelayMs: number
  /** 개인화 비율 0~1 — SSG 후보 여부를 가름 */
  personalizedRatio: number
  /** 요구 신선도(ms). REVALIDATE_MS보다 짧으면 ISR로 못 맞춘다 */
  freshnessMs: number
  /** SEO 중요도 0~1 */
  seoWeight: number
  /** 결제·인증 등 정합성 리스크가 있어 SSR로 고정하는 라우트 */
  hardPinned: boolean
}

type TypeDefaults = Omit<Route, 'key'>

/**
 * 유형별 기준값. 다섯 유형은 **서로 다른 축에서 무겁도록** 배정한다.
 * 이래야 모드 우열이 유형별로 갈리고 결정 경계가 생긴다(설계 문서 §5).
 */
const DEFAULTS: Record<RouteType, TypeDefaults> = {
  // 전송 바이트 지배 · SEO 필수 · SSG 가능
  content: {
    type: 'content', nodeCount: 2500, interactiveCount: 2, payloadKB: 120,
    fetchDepth: 1, fetchDelayMs: 0, personalizedRatio: 0,
    freshnessMs: 3_600_000, seoWeight: 1, hardPinned: false,
  },
  // DOM 노드 수 지배 · 부분 개인화(θ_p 아래) · SSG 가능
  list: {
    type: 'list', nodeCount: 5000, interactiveCount: 6, payloadKB: 150,
    fetchDepth: 1, fetchDelayMs: 0, personalizedRatio: 0.1,
    freshnessMs: 600_000, seoWeight: 0.7, hardPinned: false,
  },
  // 하이드레이션 CPU 지배 · SEO 무관 · SSG 불가
  dashboard: {
    type: 'dashboard', nodeCount: 4000, interactiveCount: 24, payloadKB: 60,
    fetchDepth: 3, fetchDelayMs: 20, personalizedRatio: 0.8,
    freshnessMs: 10_000, seoWeight: 0, hardPinned: false,
  },
  // 인터랙션 준비(INP) 지배 · DOM은 작음 · SSG 불가
  form: {
    type: 'form', nodeCount: 1200, interactiveCount: 18, payloadKB: 30,
    fetchDepth: 1, fetchDelayMs: 0, personalizedRatio: 0.4,
    freshnessMs: 30_000, seoWeight: 0.2, hardPinned: false,
  },
  // 캐시 불가 + 서버 부하 민감 · SSG 불가
  personalized: {
    type: 'personalized', nodeCount: 3000, interactiveCount: 10, payloadKB: 90,
    fetchDepth: 2, fetchDelayMs: 10, personalizedRatio: 1.0,
    freshnessMs: 0, seoWeight: 0, hardPinned: false,
  },
}

/**
 * 인스턴스별로 **지배 축만** ±60% 범위로 흩뿌린다.
 * 모든 축을 동시에 흔들면 어떤 축이 결정을 갈랐는지 사후에 분리할 수 없다.
 */
const SPREAD = [0.4, 0.7, 1.0, 1.3, 1.6] as const

/** 인스턴스 간에 변할 수 있는 축 — 전부 수치형이어야 한다 */
type NumericAxis = {
  [K in keyof TypeDefaults]: TypeDefaults[K] extends number ? K : never
}[keyof TypeDefaults]

/** 유형별 지배 축 — 이 축만 인스턴스 간에 변한다 */
const DOMINANT_AXIS: Record<RouteType, NumericAxis> = {
  content: 'payloadKB',
  list: 'nodeCount',
  dashboard: 'interactiveCount',
  form: 'interactiveCount',
  personalized: 'fetchDelayMs',
}

function buildRoutes(): Route[] {
  const out: Route[] = []
  for (const type of ROUTE_TYPES) {
    const base = DEFAULTS[type]
    const axis = DOMINANT_AXIS[type]
    SPREAD.forEach((factor, i) => {
      const key = `${type}-${String(i + 1).padStart(2, '0')}`
      const scaled = Math.max(1, Math.round(base[axis] * factor))
      out.push({ ...base, key, [axis]: scaled })
    })
  }
  return out
}

export const ROUTES: Route[] = buildRoutes()

export function routesOf(type: RouteType): Route[] {
  return ROUTES.filter((r) => r.type === type)
}

export function resolveRoute(type: string, key: string): Route | undefined {
  return ROUTES.find((r) => r.type === type && r.key === key)
}

/**
 * 실행 가능 모드 집합 M_route(r). 제안서 §3.1.1.
 *
 * 실행 불가능한 조합은 factorial 그리드에서 **아예 빠진다.** 측정한 뒤
 * 걸러내는 것이 아니다. 개인화 라우트에서 SSG를 후보로 남겨두면 캐시 히트 시
 * 렌더 비용이 0에 가까워 J가 최소가 되고, 모델은 "항상 SSG"를 학습한다.
 */
export function candidateModes(route: Route): Mode[] {
  if (route.hardPinned) return ['ssr']
  const modes: Mode[] = ['csr', 'ssr', 'stream', 'islands']
  if (route.personalizedRatio <= THETA_P && route.freshnessMs >= REVALIDATE_MS) {
    modes.push('ssg')
  }
  return modes
}

export function isModeAllowed(mode: Mode, route: Route): boolean {
  return candidateModes(route).includes(mode)
}

/** 그리드 크기 Σ_r |M(r)| — 실험 메타데이터에 기록한다(제안서 부록 B). */
export function totalCandidateCells(): number {
  return ROUTES.reduce((sum, r) => sum + candidateModes(r).length, 0)
}
