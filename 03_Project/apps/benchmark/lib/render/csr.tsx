import { recordRender } from '@/lib/instrument/record'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps, type RootComponent } from './shell'

/**
 * CSR — 셸만 전송하고 데이터는 클라이언트가 /api/data로 가져온다.
 * getData를 서버에서 호출하지 않는다는 점이 다른 모드와의 결정적 차이다.
 */
export function renderCsr(type: RouteType, ClientRoot: RootComponent) {
  return async function Page({ params }: PageProps) {
    const { route, slug } = await resolveForRender('csr', type, params)
    /*
     * CSR의 서버 비용은 두 조각이다: 여기의 셸 렌더(작다)와 /api/data 호출.
     * 둘 다 같은 cid로 기록되므로, 요청당 서버 비용은 cid로 묶어 합산해야 한다.
     */
    return recordRender('csr', route, async () => (
      <Root mode="csr">
        <ClientRoot type={type} routeKey={slug} />
      </Root>
    ))
  }
}
