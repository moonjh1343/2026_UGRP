import { getData } from '@/lib/data'
import { recordRender } from '@/lib/instrument/record'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps, type TreeComponent } from './shell'

/**
 * SSR과 SSG·ISR — 서버에서 트리를 렌더하고 클라이언트가 **전체 하이드레이션**한다.
 *
 * 두 모드의 렌더 경로는 완전히 같다. 차이는 페이지 파일의 세그먼트 설정
 * (force-dynamic vs force-static + revalidate)뿐이다.
 *
 * Tree는 반드시 **클라이언트 경계 심**(*.client.tsx)이어야 한다.
 * 원본 트리를 넘기면 서버 그래프에 머물러 Islands와 구분되지 않는다.
 */
export function renderHydrated(mode: 'ssr' | 'ssg', type: RouteType, Tree: TreeComponent) {
  return async function Page({ params }: PageProps) {
    const { route } = await resolveForRender(mode, type, params)
    return recordRender(mode, route, async () => {
      const data = (await getData(route)) as never
      return (
        <Root mode={mode}>
          <Tree data={data} />
        </Root>
      )
    })
  }
}
