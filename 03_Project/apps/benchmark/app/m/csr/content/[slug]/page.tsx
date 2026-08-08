import Root from '@/components/shell/roots/ContentRoot'
import { renderCsr } from '@/lib/render/csr'

export const dynamic = 'force-dynamic'

export default renderCsr('content', Root)
