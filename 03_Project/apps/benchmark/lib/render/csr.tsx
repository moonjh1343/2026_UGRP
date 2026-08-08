import { ClientRoot } from '@/components/shell/ClientRoot'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps } from './shell'

/**
 * CSR — 셸만 전송하고 데이터는 클라이언트가 /api/data로 가져온다.
 *
 * getData를 서버에서 호출하지 않는다는 점이 다른 모드와의 결정적 차이다.
 */
export function renderCsr(type: RouteType) {
  return async function Page({ params }: PageProps) {
    const { slug } = await resolveForRender('csr', type, params)
    return (
      <Root mode="csr">
        <ClientRoot type={type} routeKey={slug} />
      </Root>
    )
  }
}
