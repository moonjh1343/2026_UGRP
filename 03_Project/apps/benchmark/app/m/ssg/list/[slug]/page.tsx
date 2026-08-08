import Tree from '@/components/trees/ListTree.client'
import { renderHydrated } from '@/lib/render/hydrated'
import { REVALIDATE_MS, routesOf } from '@/lib/routes'

export const dynamic = 'force-static'

/**
 * 세그먼트 설정은 Next.js가 정적 분석하므로 리터럴이어야 한다.
 * REVALIDATE_MS와 이중 관리되므로 아래 단언으로 드리프트를 빌드 시점에 잡는다.
 */
export const revalidate = 60

if (REVALIDATE_MS !== revalidate * 1000) {
  throw new Error(`revalidate 불일치: ${revalidate}s vs REVALIDATE_MS ${REVALIDATE_MS}ms`)
}

export function generateStaticParams() {
  return routesOf('list').map((r) => ({ slug: r.key }))
}

export default renderHydrated('ssg', 'list', Tree)
