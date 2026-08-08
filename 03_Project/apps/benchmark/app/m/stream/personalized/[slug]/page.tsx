import Tree from '@/components/trees/PersonalizedTree.client'
import { renderStream } from '@/lib/render/stream'

export const dynamic = 'force-dynamic'

export default renderStream('personalized', Tree)
