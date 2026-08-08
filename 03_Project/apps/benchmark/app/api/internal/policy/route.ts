import {
  MODEL_IS_FITTED,
  MODEL_VERSION,
  POLICY_NAMES,
  TAU,
  bundlesGenerated,
} from '@/policy'

export const dynamic = 'force-dynamic'

/**
 * 결정 계층 내성(introspection). 검증 스크립트가 정책 목록·τ·모델 버전을
 * 하드코딩하지 않도록 노출한다.
 *
 * **이 라우트는 계측 도구이지 SUT의 일부가 아니다.** `/api/internal/*`는 5단계에서
 * 걷어낸다. 앱의 렌더 경로(`app/m/`, `components/`, `lib/render/`)가 `@/policy`를
 * 임포트하지 않는 것이 4단계 합격 기준이고, `check:policy`가 그 경계를 검사한다.
 */
export async function GET() {
  return Response.json(
    {
      policies: POLICY_NAMES,
      tau: TAU,
      model: { version: MODEL_VERSION, fitted: MODEL_IS_FITTED },
      bundlesGenerated: bundlesGenerated(),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
