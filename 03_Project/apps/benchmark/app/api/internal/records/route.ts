import { reset, store } from '@/lib/instrument/store'

export const dynamic = 'force-dynamic'

/**
 * 조인 검증용 레코드 덤프. 2단계 검증 스크립트(check:join)가 사용한다.
 * 데이터 레이크 도입 전까지의 임시 창구이며, 실배포 대상이 아니다.
 */
export async function GET() {
  const s = store()
  return Response.json(
    {
      renders: s.renders,
      beacons: s.beacons,
      cacheStatus: s.cacheStatus,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/** 검증 실행 사이에 상태를 비운다. */
export async function DELETE() {
  reset()
  return new Response(null, { status: 204 })
}
