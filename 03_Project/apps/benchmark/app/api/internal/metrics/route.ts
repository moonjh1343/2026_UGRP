import { snapshot } from '@/lib/instrument/serverState'

export const dynamic = 'force-dynamic'

/**
 * 서버 상태 스냅샷. 결정 계층이 30초 주기로 캐시해 쓴다(제안서 §6.7).
 * 요청마다 조회하면 그 왕복이 TTFB에 얹혀 측정 대상을 왜곡한다.
 */
export async function GET() {
  return Response.json(snapshot(), {
    headers: { 'cache-control': 'no-store' },
  })
}
