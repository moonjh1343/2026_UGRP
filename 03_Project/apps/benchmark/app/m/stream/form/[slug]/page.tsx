import Tree from '@/components/trees/FormTree.client'
import { renderStream } from '@/lib/render/stream'

export const dynamic = 'force-dynamic'

export default renderStream('form', Tree)
