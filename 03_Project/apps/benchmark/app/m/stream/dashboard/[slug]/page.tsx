import Tree from '@/components/trees/DashboardTree.client'
import { renderStream } from '@/lib/render/stream'

export const dynamic = 'force-dynamic'

export default renderStream('dashboard', Tree)
