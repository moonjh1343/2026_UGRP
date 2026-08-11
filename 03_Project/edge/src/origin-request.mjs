/**
 * Lambda@Edge — 오리진 요청.
 *
 * **캐시 미스에서만 돈다.** 캐시 히트는 결정할 것이 없다 — 응답이 이미 특정 모드로
 * 렌더돼 있고, 그 위에서 모델을 돌리는 것은 순수한 낭비다. 미스 경로는 어차피
 * 오리진 렌더가 지배하므로 추론 2ms 예산도 여유롭다(README의 "왜 오리진 요청인가").
 *
 * 이 파일은 **어댑터다.** 정책 로직은 `apps/benchmark/policy/`에 있고 여기서 임포트한다.
 * 옮겨 적으면 랩에서 검증한 것과 필드에서 도는 것이 갈리고, 그 순간 4단계 검사
 * (`check:policy`)가 필드 동작을 보증하지 않게 된다.
 *
 * Lambda@Edge 제약 때문에 생긴 모양:
 *   - 환경변수를 쓸 수 없다 → 설정은 빌드 시점에 굽는다(config.js)
 *   - 응답 후 실행이 동결된다 → 서버 상태 갱신을 await 하지 않고 던져만 둔다.
 *     다음 호출에서 해동되며 이어진다. 값이 최대 30초 스테일이어도 되는 설계라 괜찮다.
 */
import { collect, decide, EFFECTIVE_TYPES, lookup, parsePublicPath, readDecisions, scheduleRefresh } from '@policy'
import { EXPLORE_RATE, ORIGIN_URL, POLICY_NAME } from './config.js'

const HEADER = {
  correlationId: 'x-correlation-id',
  forceMode: 'x-render-mode',
  decisionReason: 'x-decision-reason',
  decisionMargin: 'x-decision-margin',
  policy: 'x-policy',
  policyUs: 'x-policy-us',
  bucket: 'x-ugrp-bucket',
  /** 무작위화 성향 점수. 오프폴리시 평가에 필수다 — 없으면 필드 데이터가 편향된 채 남는다. */
  propensity: 'x-ugrp-propensity',
}

/** lib/instrument/correlation.ts의 COOKIE.decision. 앱과 같은 쿠키를 읽어야 상한이 이어진다. */
const COOKIE_DECISION = '__dec'

/** CloudFront 헤더(`{name: [{key, value}]}`)를 정책 계층의 RequestLike로 감싼다. */
function toRequestLike(cf) {
  const get = (name) => {
    const v = cf.headers[name.toLowerCase()]
    return v && v.length ? v[0].value : null
  }
  const cookieHeader = get('cookie') ?? ''
  const jar = new Map()
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return {
    headers: { get },
    cookies: { get: (n) => (jar.has(n) ? { value: jar.get(n) } : undefined) },
  }
}

const setHeader = (cf, name, value) => {
  cf.headers[name.toLowerCase()] = [{ key: name, value: String(value) }]
}

/**
 * 뷰어 요청이 만든 버킷을 조건 주입 헤더로 되돌린다.
 *
 * 버킷은 캐시 키에 들어가느라 접힌 값이라, 정책이 보는 피처도 **접힌 값이어야 한다.**
 * 원본 Client Hints를 그대로 쓰면 같은 캐시 항목을 공유하는 요청들이 서로 다른 모드를
 * 고르게 되고, 실제로 응답을 만든 모드와 기록된 모드가 어긋난다.
 */
function applyBucket(cf, bucket) {
  const parts = String(bucket ?? '').split('-')
  if (parts.length !== 4) return
  const [tier, ectIdx, bot, saveData] = parts
  setHeader(cf, 'x-cell-device-tier', tier)
  // 역매핑의 순서 원본은 정책 계층이다 — 인라인 사본은 "어댑터가 복사본이 되는" 시작점이었다.
  setHeader(cf, 'x-cell-effective-type', EFFECTIVE_TYPES[Number(ectIdx)] ?? '4g')
  if (bot === '1') setHeader(cf, 'user-agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)')
  if (saveData === '1') setHeader(cf, 'save-data', 'on')
}

/**
 * 상관 ID. 결정은 엣지에서, 측정은 브라우저에서 일어난다 — 이 둘을 잇지 못하면
 * 데이터셋이 통째로 무가치하다. crypto.randomUUID는 Node 18+ 전역에 있다.
 */
const newCid = () => globalThis.crypto.randomUUID()

export async function handler(event) {
  const cf = event.Records[0].cf.request

  const parsed = parsePublicPath(cf.uri)
  const entry = parsed ? lookup(parsed.type, parsed.key) : undefined
  // 공개 라우트가 아니면(정적 자산, /api 등) 손대지 않는다.
  if (!entry) return cf

  const bucket = cf.headers[HEADER.bucket]?.[0]?.value
  applyBucket(cf, bucket)

  const req = toRequestLike(cf)
  const features = collect(req, entry)
  // 세션 전환 상한은 쿠키에 실려 온다(제안서 §3.5). middleware.ts와 같은 쿠키를 읽는다.
  const session = readDecisions(req.cookies.get(COOKIE_DECISION)?.value)

  const decision = decide({
    entry,
    features,
    policyName: POLICY_NAME,
    forcedMode: null, // 필드에서는 강제 지정이 없다. 그건 랩 수집 경로다.
    session,
  })

  /*
   * 필드 무작위화 (제안서 §5.5).
   *
   * 트래픽 일부를 무작위 모드로 보내고 **성향 점수를 함께 남긴다.** 이게 없으면
   * 수집된 필드 데이터가 전부 현재 정책의 선택에 편향되어, 다른 정책을 사후에
   * 평가할 방법이 사라진다(오프폴리시 평가 불가).
   *
   * 하드 고정(단일 후보·봇·서킷)은 무작위화 대상이 아니다. SEO와 정확성은 모델도
   * 무작위화도 건드리지 않는다는 규칙이 여기서도 같다.
   */
  const eligible = decision.reason !== 'single' && decision.reason !== 'bot' && decision.reason !== 'circuit'
  let mode = decision.mode
  /*
   * 하드 고정(단일 후보·봇·서킷)은 무작위화 대상이 아니므로 이 모드가 서빙될 확률은
   * 정확히 1이다. 1-EXPLORE_RATE로 두면 IPS 가중치에 1/0.95 ≈ 1.05배가 조용히
   * 곱해진다 — eligible 분기에서만 실제 확률로 바꾼다.
   */
  let propensity = 1
  let reason = decision.reason

  if (eligible && EXPLORE_RATE > 0 && Math.random() < EXPLORE_RATE) {
    const cands = decision.candidates
    mode = cands[Math.floor(Math.random() * cands.length)]
    propensity = EXPLORE_RATE / cands.length
    reason = 'explore'
  } else if (eligible) {
    // 정책이 고른 모드가 뽑힐 확률: 탐색하지 않을 확률 + 탐색해서 우연히 같은 걸 고를 확률
    propensity = 1 - EXPLORE_RATE + EXPLORE_RATE / decision.candidates.length
  }

  setHeader(cf, HEADER.forceMode, mode)
  setHeader(cf, HEADER.policy, decision.policy)
  setHeader(cf, HEADER.decisionReason, reason)
  setHeader(cf, HEADER.policyUs, decision.inferenceUs.toFixed(1))
  setHeader(cf, HEADER.propensity, propensity.toFixed(6))
  if (decision.margin != null && Number.isFinite(decision.margin)) {
    setHeader(cf, HEADER.decisionMargin, decision.margin.toFixed(4))
  }
  // 클라이언트가 보낸 cid는 신뢰하지 않는다 — 조인 키를 위조하면 데이터셋이 오염된다.
  setHeader(cf, HEADER.correlationId, newCid())

  /*
   * 서버 상태 갱신을 예약한다. **await 하지 않는다.** 기다리면 그 왕복이 통째로
   * TTFB에 얹혀, 측정하려는 개선폭보다 큰 오염이 된다. Lambda@Edge는 응답 후
   * 실행을 동결했다가 다음 호출에서 해동하므로 이 promise는 이어서 완료된다.
   */
  scheduleRefresh(ORIGIN_URL)

  return cf
}
