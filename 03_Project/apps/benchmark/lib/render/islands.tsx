import { ContentTree } from '@/components/trees/ContentTree'
import { getData } from '@/lib/data'
import { recordRender } from '@/lib/instrument/record'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps } from './shell'

/**
 * Islands — 트리가 **서버 그래프에 머문다.**
 *
 * ContentTree를 (경계 심이 아니라) 원본 그대로 임포트하므로 트리 코드는
 * 클라이언트 번들에 들어가지 않고, 'use client'가 붙은 위젯만 섬으로 하이드레이션된다.
 *
 * 이 모듈은 ContentTree.client를 **절대 임포트하면 안 된다.** 하나라도 참조하면
 * 트리 전체가 클라이언트 그래프로 끌려 들어가 SSR과 동일한 번들이 된다.
 */
export function renderIslands(type: RouteType) {
  return async function Page({ params }: PageProps) {
    const { route } = await resolveForRender('islands', type, params)
    return recordRender('islands', route, async () => {
      const data = await getData(route)
      return (
        <Root mode="islands">
          <ContentTree data={data} />
        </Root>
      )
    })
  }
}
