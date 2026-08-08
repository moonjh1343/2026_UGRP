import Tree from '@/components/trees/ListTree.client'
import { renderStream } from '@/lib/render/stream'

export const dynamic = 'force-dynamic'

export default renderStream('list', Tree)
