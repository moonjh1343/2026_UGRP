/**
 * 피처 수집 (제안서 §3.4).
 *
 * 여기서 하는 일은 전부 **헤더 파싱과 룩업**뿐이다. 정규식 컴파일·객체 순회 같은
 * 것을 요청마다 하면 그것이 곧 추론 오버헤드가 되어, 4단계 합격 기준(< 2ms)을
 * 정책이 아니라 피처 수집이 소진한다.
 */
import { COOKIE, HEADER } from '@/lib/instrument/correlation'
import type { Mode } from '@/lib/modes'
import type { EffectiveType, Features } from './types'
import type { RouteEntry } from './routeTable'
import { cachedSnapshot } from './serverState'

/** 헤더만 읽으면 되는 최소 인터페이스 — NextRequest에 묶이지 않게 한다 */
export type RequestLike = {
  headers: { get(name: string): string | null }
  cookies: { get(name: string): { value: string } | undefined }
}

const EFFECTIVE_TYPES: readonly EffectiveType[] = ['slow-2g', '2g', '3g', '4g']

/**
 * 크롤러 판정. SEO 리스크는 모델에 위임하지 않는다(제안서 §3.5).
 *
 * **헤드리스 브라우저를 봇으로 잡으면 안 된다.** 측정 워커가 곧 헤드리스 Chrome이므로,
 * `headlesschrome`이나 `lighthouse`를 여기 넣으면 모든 워커 요청이 SSR로 고정되어
 * 정책이 실제로 무엇을 고르는지 영영 측정할 수 없다. 4단계 첫 실행에서 실제로
 * 이렇게 걸렸고, 검증의 B·E 절이 통째로 무의미해졌다.
 *
 * 반대 방향의 비대칭은 유지한다: 오탐(사람을 봇으로 봄)은 SSR을 주므로 안전하고
 * 미탐(봇을 사람으로 봄)은 CSR을 줄 수 있어 위험하다. 그래서 자기 신고형 크롤러는
 * 넓게 잡되, "자동화 도구"라는 이유만으로 잡지는 않는다.
 */
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|duckduckgo/i

function n(v: string | null, fallback: number): number {
  if (v === null) return fallback
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

/**
 * 기기 등급 1~4. Client Hints가 있으면 그것으로, 없으면 UA 사전 분포로 대체한다
 * (제안서 §3.4 콜드 스타트 처리).
 */
function deviceTierFrom(memory: number, cores: number, ua: string): number {
  if (memory > 0 || cores > 0) {
    const score = Math.min(memory || 4, 8) / 8 + Math.min(cores || 4, 16) / 16
    if (score < 0.4) return 1
    if (score < 0.7) return 2
    if (score < 1.1) return 3
    return 4
  }
  // 콜드 스타트: UA만으로 대략의 사전 분포를 준다
  if (/android\s[4-8]\./i.test(ua)) return 1
  if (/android/i.test(ua)) return 2
  if (/iphone|ipad/i.test(ua)) return 3
  return 3
}

type Profile = { lcp?: number; tbt?: number; dm?: number; hc?: number }

/** 세션 프로파일 쿠키(base64 JSON). 깨져 있으면 조용히 무시한다 — 결정을 막을 이유가 없다. */
function readProfile(raw: string | undefined): Profile {
  if (!raw) return {}
  try {
    return JSON.parse(atob(decodeURIComponent(raw))) as Profile
  } catch {
    return {}
  }
}

export function collect(req: RequestLike, entry: RouteEntry): Features {
  const h = req.headers
  const ua = h.get('user-agent') ?? ''
  const profile = readProfile(req.cookies.get(COOKIE.profile)?.value)
  const { snap, ageMs } = cachedSnapshot()
  const route = entry.route

  /*
   * 조건 주입 우선. 워커가 CDP로 건 스로틀링은 Client Hints에 반영되지 않으므로,
   * 랩 셀에서는 워커가 알려준 값이 유일한 진실이다. 필드 트래픽에는 이 헤더가 없다.
   */
  const injectedTier = h.get(HEADER.cellDeviceTier)
  const injectedNet = h.get(HEADER.cellEffectiveType)
  const conditionInjected = injectedTier !== null || injectedNet !== null

  const deviceMemory = n(h.get('sec-ch-device-memory') ?? h.get('device-memory'), profile.dm ?? 0)
  /*
   * hardwareConcurrency에 대응하는 Client Hint는 표준에 없다. 첫 요청에는 값이 없고,
   * 비콘이 세션 프로파일 쿠키에 적어준 뒤부터 쓸 수 있다 — 콜드 스타트의 실체다.
   */
  const cores = profile.hc ?? 0

  const effectiveType = ((injectedNet ??
    h.get('ect') ??
    h.get('sec-ch-ect') ??
    'unknown') as string) as EffectiveType

  const guard = snap.guardrails ?? { hydrationErrorRate: 0, errorRate5xx: 0 }

  return {
    routeType: route.type,
    routeKey: route.key,
    nodeCount: route.nodeCount,
    interactiveCount: route.interactiveCount,
    payloadKB: route.payloadKB,
    fetchDepth: route.fetchDepth,
    fetchDelayMs: route.fetchDelayMs,
    personalizedRatio: route.personalizedRatio,
    seoWeight: route.seoWeight,
    bundleKB: entry.bundleKB,

    deviceTier: injectedTier !== null ? n(injectedTier, 3) : deviceTierFrom(deviceMemory, cores, ua),
    deviceMemory,
    hardwareConcurrency: cores,
    prevLcpMs: profile.lcp ?? null,
    prevTbtMs: profile.tbt ?? null,

    effectiveType: EFFECTIVE_TYPES.includes(effectiveType) ? effectiveType : 'unknown',
    rttMs: n(h.get(HEADER.cellRttMs) ?? h.get('rtt'), 0),
    downlinkMbps: n(h.get(HEADER.cellDownlink) ?? h.get('downlink'), 0),
    saveData: (h.get('save-data') ?? h.get('sec-ch-save-data')) === 'on',

    cpuPct: snap.cpuPct,
    eventLoopP95Ms: snap.eventLoopP95Ms,
    inflight: snap.inflight,
    cacheHitRate: snap.cacheHitRate,
    routeRps: snap.routeRps[route.key] ?? 0,
    serverStateAgeMs: Number.isFinite(ageMs) ? ageMs : -1,
    hydrationErrorRate: guard.hydrationErrorRate,
    errorRate5xx: guard.errorRate5xx,

    isBot: BOT_UA.test(ua),
    isRepeatVisit: req.cookies.get(COOKIE.sessionId) !== undefined,
    conditionInjected,
  }
}

/**
 * 트리 입력용 수치 벡터. 트리 JSON은 이 키 이름으로 분기하므로
 * **키를 바꾸면 모델을 다시 증류해야 한다.** 학습 파이프라인과의 계약이다.
 */
export function toVector(f: Features, mode: Mode, modeIndex: number): Record<string, number> {
  return {
    mode: modeIndex,
    deviceTier: f.deviceTier,
    deviceMemory: f.deviceMemory,
    hardwareConcurrency: f.hardwareConcurrency,
    effectiveTypeIdx: f.effectiveType === 'unknown' ? 3 : EFFECTIVE_TYPES.indexOf(f.effectiveType),
    rttMs: f.rttMs,
    downlinkMbps: f.downlinkMbps,
    saveData: f.saveData ? 1 : 0,
    prevLcpMs: f.prevLcpMs ?? -1,
    prevTbtMs: f.prevTbtMs ?? -1,

    cpuPct: f.cpuPct,
    eventLoopP95Ms: f.eventLoopP95Ms,
    inflight: f.inflight,
    cacheHitRate: f.cacheHitRate,
    routeRps: f.routeRps,

    nodeCount: f.nodeCount,
    interactiveCount: f.interactiveCount,
    payloadKB: f.payloadKB,
    fetchDepth: f.fetchDepth,
    fetchDelayMs: f.fetchDelayMs,
    personalizedRatio: f.personalizedRatio,
    seoWeight: f.seoWeight,
    bundleKB: f.bundleKB[mode] ?? 0,

    isRepeatVisit: f.isRepeatVisit ? 1 : 0,
  }
}
