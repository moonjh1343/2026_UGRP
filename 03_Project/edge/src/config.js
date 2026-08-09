/**
 * 엣지 설정.
 *
 * **Lambda@Edge는 환경변수를 지원하지 않는다.** 그래서 설정을 코드에 굽고, 바꾸려면
 * 다시 배포한다. 불편해 보이지만 재현성 쪽에는 유리하다 — "그때 어떤 설정으로
 * 돌았는가"가 Lambda 버전에 고정되고, 배포와 무관하게 바뀌는 값이 없다.
 *
 * build.mjs가 배포 시점에 이 파일의 값을 덮어쓸 수 있다(--origin, --explore).
 */

/** 서버 상태를 읽어올 오리진. `scheduleRefresh`가 백그라운드로만 친다. */
export const ORIGIN_URL = 'https://origin.invalid'

/**
 * 필드 무작위화 비율 (제안서 §5.5의 5~10%).
 *
 * 0으로 두면 오프폴리시 평가에 쓸 데이터가 전혀 모이지 않는다 — 모든 관측이 현재
 * 정책의 선택이라, 다른 정책이 더 나았을지를 사후에 물을 수 없다. 그렇다고 높이면
 * 그만큼의 사용자가 일부러 열등할 수 있는 모드를 받는다.
 */
export const EXPLORE_RATE = 0.05

/** 적용할 정책 이름. null이면 policy/config.ts의 DEFAULT_POLICY. */
export const POLICY_NAME = null
