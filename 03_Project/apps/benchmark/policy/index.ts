/**
 * 결정 계층 진입점.
 *
 * 정책은 "무엇을 고르고 싶은가"만 말하고, 실행 가능성·안전장치·전환 상한은
 * 전부 여기서 강제한다. 그래야 정책을 추가할 때 안전장치를 매번 다시 구현하지
 * 않아도 되고, 모든 실험군이 동일한 가드 체인을 통과한다(제안서 §3.5).
 *
 * 가드 체인의 순서가 곧 우선순위다.
 *   forced → single → bot → circuit → policy → infeasible → margin → session-cap
 *
 * bot이 circuit보다 먼저인 이유: 서킷 브레이커의 기본 모드(Streaming SSR)도
 * 크롤러에게는 SSR과 사실상 동등하지만, SEO 고정은 "모델이 건드리지 않는다"는
 * 규칙이므로 어떤 상태에서도 뒤집히지 않아야 한다.
 */
import { DEFAULT_MODE, MODES, type Mode } from '@/lib/modes'
import { CIRCUIT, DEFAULT_POLICY, SESSION_SWITCH_CAP, TAU } from './config'
import type { Decision, DecisionReason, Features } from './types'
import type { RouteEntry } from './routeTable'
import { resolvePolicy } from './policies'
import { touch, type SessionDecision } from './session'

export { collect } from './features'
export { lookup, parseForcedPath, parsePublicPath, bundlesGenerated } from './routeTable'
export { readDecisions, writeDecisions } from './session'
export { scheduleRefresh } from './serverState'
export { POLICIES, POLICY_NAMES } from './policies'
export { MODEL_VERSION, MODEL_IS_FITTED } from './surrogate'
export { TAU } from './config'
export type { Decision, Features } from './types'

/** M(x) 안에서 원하는 모드를, 없으면 기본 모드를, 그것도 없으면 첫 후보를 준다. */
function within(cands: Mode[], want: Mode): Mode {
  if (cands.includes(want)) return want
  if (cands.includes(DEFAULT_MODE)) return DEFAULT_MODE
  return cands[0]
}

function done(
  base: Omit<Decision, 'inferenceUs'>,
  t0: number,
): Decision {
  return { ...base, inferenceUs: (performance.now() - t0) * 1000 }
}

export type DecideInput = {
  entry: RouteEntry
  features: Features
  policyName: string | null
  /** 워커가 헤더로 강제 지정한 모드 — factorial 수집 경로 */
  forcedMode: string | null
  session: Map<string, SessionDecision>
}

export function decide(input: DecideInput): Decision {
  const t0 = performance.now()
  const { entry, features: f, session } = input
  const cands = entry.candidates
  const key = entry.route.key

  const shell = (mode: Mode, reason: DecisionReason, intended: Mode = mode) => ({
    mode,
    policy: input.policyName ?? DEFAULT_POLICY,
    reason,
    intended,
    candidates: cands,
    scores: null,
    margin: null,
  })

  /*
   * 1) 강제 지정. factorial 수집에서는 동일 조건에서 5개 모드를 모두 측정해야
   *    반사실 데이터가 나오므로, 워커가 정책을 우회한다(설계 문서 §2).
   *    이때도 M(x) 밖은 허용하지 않는다 — 그리드 정의에서 이미 빠진 셀이다.
   *
   *    **세션은 여기서도 갱신한다.** 필드 경로에서 forced는 "엣지가 이미 내린
   *    결정"인데, 엣지(origin-request)는 응답 쿠키를 쓸 수 없어 자기 세션 갱신을
   *    버린다. 응답 쿠키를 쓸 수 있는 오리진의 이 지점이 전환 집계를 이어받지
   *    않으면 __dec가 영영 비고 session-cap이 필드에서 한 번도 발동하지 않는다.
   *    랩 수집은 /m/ 직접 경로라 decide() 자체를 타지 않는다 — 영향 없다.
   */
  if (input.forcedMode && MODES.includes(input.forcedMode as Mode)) {
    const want = input.forcedMode as Mode
    const applied = within(cands, want)
    const forcedPrior = session.get(key)
    if (!forcedPrior || !cands.includes(forcedPrior.mode)) {
      touch(session, key, { mode: applied, switches: 0 })
    } else if (forcedPrior.mode !== applied) {
      touch(session, key, { mode: applied, switches: forcedPrior.switches + 1 })
    }
    return done(shell(applied, cands.includes(want) ? 'forced' : 'infeasible', want), t0)
  }

  // 2) 후보가 하나뿐이면 폴백도 무의미하다. 결제·인증 라우트(hardPinned)가 여기 걸린다.
  if (cands.length === 1) return done(shell(cands[0], 'single'), t0)

  // 3) 크롤러 → SSR 고정. SEO 리스크는 모델에 위임하지 않는다.
  if (f.isBot) return done(shell(within(cands, 'ssr'), 'bot'), t0)

  // 4) 서킷 브레이커 — 하이드레이션 오류나 5xx가 튀면 전 트래픽을 기본 모드로 되돌린다.
  if (f.hydrationErrorRate > CIRCUIT.hydrationErrorRate || f.errorRate5xx > CIRCUIT.errorRate5xx) {
    return done(shell(within(cands, DEFAULT_MODE), 'circuit'), t0)
  }

  const resolved = resolvePolicy(input.policyName) ?? resolvePolicy(DEFAULT_POLICY)
  if (!resolved) return done(shell(within(cands, DEFAULT_MODE), 'circuit'), t0)

  const { mode: intended, scores } = resolved.fn(f, cands)

  /*
   * 세션의 이전 결정. 쿠키에서 왔으므로 어휘는 session.ts가 걸렀지만, **이 라우트의
   * M(x)에 속하는지는 여기서만 확인할 수 있다.** 후보 밖 모드가 남아 있으면(배포 간
   * 후보 축소, 위조 쿠키) 없는 것으로 친다 — session-cap이 그 모드를 복원하면
   * "mode는 항상 M(x)의 원소" 불변식이 깨진다.
   */
  const rawPrior = session.get(key)
  const prior = rawPrior && cands.includes(rawPrior.mode) ? rawPrior : undefined

  let mode = intended
  let reason: DecisionReason = 'policy'
  let margin: number | null = null

  // 5) 실행 가능성. fixed-ssg를 개인화 라우트에 적용하면 여기 걸리고, 그 사실이 기록된다.
  if (!cands.includes(intended)) {
    mode = within(cands, DEFAULT_MODE)
    reason = 'infeasible'
  } else if (scores) {
    /*
     * 6) 마진 폴백. 상위 두 예측의 차가 τ 미만이면 **전환하지 않는다.**
     *    전환에는 캐시 파편화라는 고정비가 있으므로, 이득이 그보다 작으면 손해다.
     *    3단계 실측에서 대시보드·폼·개인화형의 상위 3개 모드는 노이즈 안에 있었다.
     *
     *    "전환하지 않는다"의 기준점은 세션의 이전 모드다. 이전 모드가 있는데
     *    DEFAULT_MODE로 가면 τ가 막으려던 바로 그 전환을 τ가 유발한다.
     *    이전 결정이 없으면 기본 모드가 보수적 선택이다.
     *    폴백이 실제로 모드를 바꿀 때만 reason을 남긴다 — 상위 1위가 이미
     *    폴백 대상과 같으면 결정은 policy 그대로이고, margin 값은 별도 필드로 남는다.
     */
    const sorted = cands
      .map((m) => ({ m, j: scores[m] ?? Infinity }))
      .sort((a, b) => a.j - b.j)
    margin = sorted.length > 1 ? sorted[1].j - sorted[0].j : Infinity
    if (margin < TAU) {
      const anchor = prior ? prior.mode : within(cands, DEFAULT_MODE)
      if (anchor !== mode) {
        mode = anchor
        reason = 'margin'
      }
    }
  }

  /*
   * 7) 세션 전환 상한. (세션, 라우트) 단위로 센다 — 세션 전체로 세면 첫 방문
   *    라우트의 결정이 세션 내내 모든 라우트를 고정해버려, 라우트별로 최적 모드가
   *    다르다는 이 연구의 전제 자체를 부정하게 된다.
   */
  if (prior && prior.mode !== mode) {
    if (prior.switches >= SESSION_SWITCH_CAP) {
      mode = prior.mode
      reason = 'session-cap'
    } else {
      touch(session, key, { mode, switches: prior.switches + 1 })
    }
  } else if (!prior) {
    touch(session, key, { mode, switches: 0 })
  }

  return done(
    {
      mode,
      policy: resolved.name,
      reason,
      intended,
      candidates: cands,
      scores: scores ?? null,
      margin,
    },
    t0,
  )
}
