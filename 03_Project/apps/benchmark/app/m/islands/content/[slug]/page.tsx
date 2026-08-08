import { ContentTree } from '@/components/trees/ContentTree'
import { renderIslands } from '@/lib/render/islands'

export const dynamic = 'force-dynamic'

// 경계 심이 아니라 **원본 트리**를 넘긴다 — 트리가 서버 그래프에 머물러야 한다.
export default renderIslands('content', ContentTree)
