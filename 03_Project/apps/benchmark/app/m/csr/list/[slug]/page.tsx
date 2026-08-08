import Root from '@/components/shell/roots/ListRoot'
import { renderCsr } from '@/lib/render/csr'

export const dynamic = 'force-dynamic'

export default renderCsr('list', Root)
