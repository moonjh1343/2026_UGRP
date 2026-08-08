import { Suspense } from 'react'
import { Skeleton } from '@/components/shell/Skeleton'
import ContentTreeClient from '@/components/trees/ContentTree.client'
import { getData } from '@/lib/data'
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

async function StreamedTree({ route }: { route: Route }) {
  const data = await getData(route)
  return <ContentTreeClient data={data} />
}
