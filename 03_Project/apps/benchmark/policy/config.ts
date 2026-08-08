/**
 * 결정 계층의 실험 파라미터.
 *
 * 전부 환경변수로 덮을 수 있어야 한다 — 같은 빌드로 τ를 바꿔가며 스윕해야
 * τ의 영향을 다른 변화와 분리할 수 있다. 값을 코드에 박으면 재빌드가 끼어들고,
 * 그러면 번들 해시가 바뀌어 브라우저 캐시 상태까지 함께 변한다.
 */

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 마진 임계값 τ. 1·2위 예측 차가 이보다 작으면 전환하지 않는다(제안서 §3.5).
 *
 * τ는 하이퍼파라미터가 아니라 **전환 고정비의 추정값**이다. 모드를 바꾸면
 * 캐시가 파편화되고(모드별 경로 = 모드별 캐시 키) 그 비용은 예측 이득과 무관하게 든다.
 *
 * 기본값 0.05는 3단계 실측에서 나온 것이다. 대시보드·폼·개인화형은 상위 3개 모드가
 * 측정 노이즈 안에 있었으므로(README 3단계 결과), 그 폭보다 작은 차이로 전환하는 것은
 * 이득이 아니라 비용이다. **5단계 데이터로 재추정해야 하는 값이다.**
 */
export const TAU = num(process.env.POLICY_TAU, 0.05)

/** 서버 상태 스냅샷 TTL. 요청마다 조회하면 그 왕복이 TTFB에 얹힌다(제안서 §6.7). */
export const SERVER_STATE_TTL_MS = num(process.env.POLICY_STATE_TTL_MS, 30_000)

/** 서킷 브레이커 임계값 — 초과 시 전 트래픽이 기본 모드로 복귀(제안서 §3.5). */
export const CIRCUIT = {
  hydrationErrorRate: num(process.env.POLICY_CB_HYDRATION, 0.02),
  errorRate5xx: num(process.env.POLICY_CB_5XX, 0.01),
}

/** 세션당 모드 전환 상한(제안서 §3.5). 라우트 단위로 센다 — 아래 주석 참조. */
export const SESSION_SWITCH_CAP = num(process.env.POLICY_SWITCH_CAP, 1)

/**
 * 세션 결정 쿠키에 담을 최대 라우트 수.
 *
 * 전환 상한을 **세션 전체**가 아니라 (세션, 라우트) 단위로 세는 이유: 한 세션이
 * 여러 라우트를 방문하는 것은 정상이고, 라우트가 다르면 최적 모드도 다른 것이
 * 이 연구의 전제다. 전역으로 세면 첫 라우트의 결정이 세션 전체를 고정해버린다.
 */
export const SESSION_DECISION_SLOTS = 8

/** 기본 정책. 워커는 요청마다 x-policy 헤더로 덮어쓴다. */
export const DEFAULT_POLICY = process.env.POLICY ?? 'surrogate'
