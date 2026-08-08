import { getData } from '@/lib/data'
import { recordRender } from '@/lib/instrument/record'
import type { RouteType } from '@/lib/routes'
import { Root, resolveForRender, type PageProps, type TreeComponent } from './shell'

/**
 * Islands — 트리가 **서버 그래프에 머문다.**
 *
 * 페이지 파일이 경계 심이 아니라 **원본 트리**를 넘기므로 트리 코드는
 * 클라이언트 번들에 들어가지 않고, 'use client'가 붙은 위젯만 섬으로 하이드레이션된다.
 *
 * 이 모듈은 *.client.tsx를 **절대 임포트하면 안 된다.** 하나라도 참조하면
 * 트리 전체가 클라이언트 그래프로 끌려 들어가 SSR과 동일한 번들이 된다.
 */
export function renderIslands(type: RouteType, Tree: TreeComponent) {
  return async function Page({ params }: PageProps) {
    const { route } = await resolveForRender('islands', type, params)
    return recordRender('islands', route, async () => {
      const data = (await getData(route)) as never
      return (
        <Root mode="islands">
          <Tree data={data} />
        </Root>
      )
    })
  }
}
