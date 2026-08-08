'use client'

import { ListTree } from '@/components/trees/ListTree'
import { makeClientRoot } from '../makeClientRoot'

/** CSR 진입점. **자기 트리만** 임포트한다 — 공용 루트를 쓰면 5개 트리가 모든 번들에 들어간다. */
export default makeClientRoot(ListTree as never)
