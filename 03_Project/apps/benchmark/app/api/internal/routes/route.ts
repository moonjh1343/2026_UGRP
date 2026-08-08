import { MODES } from '@/lib/modes'
import { ROUTES, ROUTE_TYPES, THETA_P, candidateModes, totalCandidateCells } from '@/lib/routes'

export const dynamic = 'force-dynamic'

/**
 * 라우트 테이블 노출. 검증 스크립트가 유형·인스턴스·실행 가능 모드를
 * 여기서 읽어 하드코딩을 피한다 — 라우트 정의가 늘어도 스크립트를 고칠 필요가 없다.
 */
export async function GET() {
  return Response.json(
    {
      modes: MODES,
      types: ROUTE_TYPES,
      thetaP: THETA_P,
      totalCandidateCells: totalCandidateCells(),
      routes: ROUTES.map((r) => ({ ...r, candidateModes: candidateModes(r) })),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
