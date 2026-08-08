import Tree from '@/components/trees/ContentTree.client'
import { renderHydrated } from '@/lib/render/hydrated'

export const dynamic = 'force-dynamic'

export default renderHydrated('ssr', 'content', Tree)
