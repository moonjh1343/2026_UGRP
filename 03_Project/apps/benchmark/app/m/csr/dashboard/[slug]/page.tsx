import Root from '@/components/shell/roots/DashboardRoot'
import { renderCsr } from '@/lib/render/csr'

export const dynamic = 'force-dynamic'

export default renderCsr('dashboard', Root)
