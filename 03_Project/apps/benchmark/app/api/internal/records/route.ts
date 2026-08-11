import { reset, store } from '@/lib/instrument/store'

export const dynamic = 'force-dynamic'

/**
 * 조인 검증용 레코드 덤프. 2단계 검증 스크립트(check:join)와 측정 워커가 사용한다.
 * 데이터 레이크 도입 전까지의 임시 창구이며, 실배포 대상이 아니다.
 *
 * `?cid=`를 주면 그 상관 ID의 레코드만 돌려준다. 워커의 조인 폴링(200ms 간격,
 * rep당 최대 20회)이 전체 덤프를 받으면 부하 셀에서 링 버퍼 5000건 × 수 KB의
 * JSON 직렬화가 rep마다 SUT에 얹힌다 — idle 셀의 "배경 부하 0" 전제를 침식하고
 * 부하 셀의 드리프트 검증값을 흔드는 비계측 비용이었다.
 */
export async function GET(req: Request) {
  const s = store()
  const cid = new URL(req.url).searchParams.get('cid')
  if (cid) {
    return Response.json(
      {
        renders: s.renders.filter((r) => r.cid === cid),
        beacons: s.beacons.filter((b) => b.cid === cid),
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
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
