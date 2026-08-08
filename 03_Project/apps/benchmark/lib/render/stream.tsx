import { Suspense } from 'react'
import { Skeleton } from '@/components/shell/Skeleton'
import ContentTreeClient from '@/components/trees/ContentTree.client'
import { getData } from '@/lib/data'
import { recordRender } from '@/lib/instrument/record'
import type { Route, RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps } from './shell'

/**
 * Streaming SSR — 셸을 즉시 flush하고, 데이터가 준비되면 청크로 이어붙인다.
 *
 * 하이드레이션 범위는 SSR과 같고 전달 방식만 점진적이다.
 */
export function renderStream(type: RouteType) {
  return async function Page({ params }: PageProps) {
    const { route } = await resolveForRender('stream', type, params)
    return (
      <Root mode="stream">
        <Suspense fallback={<Skeleton />}>
          <StreamedTree route={route} />
        </Suspense>
      </Root>
    )
  }
}

/**
 * Suspense 안에서 렌더되므로 CPU 계측도 여기서 한다.
 * 셸 flush 시점이 아니라 **데이터가 준비되어 트리를 만드는 구간**이 실제 렌더 비용이다.
 */
async function StreamedTree({ route }: { route: Route }) {
  return recordRender('stream', route, async () => {
    const data = await getData(route)
    return <ContentTreeClient data={data} />
  })
}
