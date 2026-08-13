import { revalidatePath } from 'next/cache'
import { ROUTE_TYPES, resolveRoute } from '@/lib/routes'

export const dynamic = 'force-dynamic'

/**
 * ISR 캐시 무효화. 측정 워커가 **캐시 상태를 셀 변수로 통제**하기 위해 쓴다.
 *
 * 제안서 §5.2: 미스·히트·stale을 명시적으로 통제하지 않으면 같은 셀 안에서 세 상태가
 * 섞여 분산이 폭발하고 §3.1.2의 missRate를 관측할 수 없다. 무효화 수단이 없으면
 * `miss` 상태를 재현할 방법 자체가 없다 — 첫 요청은 실험당 한 번뿐이기 때문이다.
 *
 * `/api/internal/*`는 계측 도구이지 SUT의 일부가 아니다. 실배포로 나가면 안 된다.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const key = searchParams.get('key')

  if (!type || !key || !ROUTE_TYPES.includes(type as never) || !resolveRoute(type, key)) {
    return Response.json({ error: `알 수 없는 라우트: ${type}/${key}` }, { status: 404 })
  }

  // SSG 진입점만 무효화 대상이다. 나머지 모드는 요청마다 렌더되므로 캐시가 없다.
  //
  // **`'page'` 타입을 주면 안 된다.** 두 번째 인자는 `/m/ssg/[type]/[slug]` 같은
  // 라우트 패턴과 짝을 이루는 형태라, 구체 URL과 조합하면 매칭되는 항목이 없어
  // 조용히 아무것도 무효화하지 않는다 — 200을 돌려주면서 캐시는 그대로라,
  // 워커의 "기대 miss, 관측 HIT" 불일치(grid-v1 실패)의 두 원인 중 하나였다.
  // 구체 URL은 인자 하나로 넘겨야 그 항목 하나가 무효화된다.
  const path = `/m/ssg/${type}/${key}`
  revalidatePath(path)

  return Response.json({ revalidated: path, ts: Date.now() }, {
    headers: { 'cache-control': 'no-store' },
  })
}
