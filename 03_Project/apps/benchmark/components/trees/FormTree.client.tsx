'use client'

import { FormTree } from './FormTree'

/**
 * 경계 심(shim). FormTree를 클라이언트 그래프로 끌어올린다.
 * 트리 정의는 FormTree.tsx 한 벌뿐이고, 이 파일은 하이드레이션 경계만 바꾼다.
 * CSR / SSR / Streaming SSR / SSG·ISR이 이 경로를 쓰고, Islands만 원본을 직접 쓴다.
 */
export default FormTree
