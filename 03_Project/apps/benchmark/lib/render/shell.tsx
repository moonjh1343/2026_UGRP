import { notFound } from 'next/navigation'
import type { Mode } from '@/lib/modes'
import { isModeAllowed, resolveRoute, type Route, type RouteType } from '@/lib/routes'

export type PageProps = { params: Promise<{ slug: string }> }

/**
 * 모드 공용 부분. **트리 컴포넌트를 임포트하지 않는다.**
 *
 * 여기서 ContentTree.client를 임포트하면 그 순간 모든 모드의 클라이언트 번들에
 * 트리가 포함되어 Islands의 이득이 사라진다. 모드별 렌더 모듈(csr/hydrated/stream/islands)이
 * 각자 필요한 것만 임포트하는 이유다.
 */
export async function resolveForRender(
  mode: Mode,
  type: RouteType,
  params: PageProps['params'],
): Promise<{ route: Route; slug: string }> {
  const { slug } = await params
  const route = resolveRoute(type, slug)
  if (!route) notFound()

  // 제안서 §3.1.1 — 실행 불가능한 조합은 조용히 넘어가지 않고 즉시 드러나야 한다.
  if (!isModeAllowed(mode, route)) {
    throw new Error(
      `실행 불가능한 조합: ${route.type}/${route.key} × ${mode} ` +
        `(personalizedRatio=${route.personalizedRatio}, freshnessMs=${route.freshnessMs})`,
    )
  }

  return { route, slug }
}

export function Root({ mode, children }: { mode: Mode; children: React.ReactNode }) {
  return (
    <div id="app-root" data-mode={mode}>
      {children}
    </div>
  )
}
