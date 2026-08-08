import Tree from '@/components/trees/PersonalizedTree.client'
import { renderHydrated } from '@/lib/render/hydrated'

export const dynamic = 'force-dynamic'

export default renderHydrated('ssr', 'personalized', Tree)
