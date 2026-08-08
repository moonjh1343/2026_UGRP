import ContentTreeClient from '@/components/trees/ContentTree.client'
import { getData } from '@/lib/data'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps } from './shell'

/**
 * SSR과 SSG·ISR — 서버에서 트리를 렌더하고 클라이언트가 **전체 하이드레이션**한다.
 *
 * 두 모드의 렌더 경로는 완전히 같다. 차이는 페이지 파일의 세그먼트 설정
 * (force-dynamic vs force-static + revalidate)뿐이다.
 */
export function renderHydrated(mode: 'ssr' | 'ssg', type: RouteType) {
  return async function Page({ params }: PageProps) {
    const { route } = await resolveForRender(mode, type, params)
    const data = await getData(route)
    return (
      <Root mode={mode}>
        <ContentTreeClient data={data} />
      </Root>
    )
  }
}
