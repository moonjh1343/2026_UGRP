import Root from '@/components/shell/roots/PersonalizedRoot'
import { renderCsr } from '@/lib/render/csr'

export const dynamic = 'force-dynamic'

export default renderCsr('personalized', Root)
