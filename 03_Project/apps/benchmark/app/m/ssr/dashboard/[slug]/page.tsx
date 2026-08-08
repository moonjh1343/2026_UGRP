import Tree from '@/components/trees/DashboardTree.client'
import { renderHydrated } from '@/lib/render/hydrated'

export const dynamic = 'force-dynamic'

export default renderHydrated('ssr', 'dashboard', Tree)
