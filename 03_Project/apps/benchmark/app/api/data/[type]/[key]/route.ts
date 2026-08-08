import { getData } from '@/lib/data'
import { resolveRoute } from '@/lib/routes'

export const dynamic = 'force-dynamic'

/**
 * CSR 전용 전송로. getData()는 SSR·SSG·Islands가 서버에서 직접 호출하는 것과
 * **동일한 함수**이고, 여기는 HTTP 껍데기만 씌운다.
 * 두 경로가 다른 코드를 타면 페이로드가 갈라져 비교가 오염된다.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ type: string; key: string }> },
) {
  const { type, key } = await params
  const route = resolveRoute(type, key)

  if (!route) {
    return Response.json({ error: `알 수 없는 라우트: ${type}/${key}` }, { status: 404 })
  }

  return Response.json(await getData(route))
}
