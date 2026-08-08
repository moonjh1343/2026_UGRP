import Tree from '@/components/trees/ContentTree.client'
import { renderStream } from '@/lib/render/stream'

export const dynamic = 'force-dynamic'

export default renderStream('content', Tree)
