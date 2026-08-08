import Tree from '@/components/trees/FormTree.client'
import { renderHydrated } from '@/lib/render/hydrated'

export const dynamic = 'force-dynamic'

export default renderHydrated('ssr', 'form', Tree)
