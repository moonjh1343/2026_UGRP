'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Skeleton } from './Skeleton'

export type TreeComponent = (props: { data: never }) => ReactNode

/**
 * CSR 진입점 팩토리.
 *
 * 유형마다 별도 파일(components/shell/roots/*)에서 호출해 **자기 트리만**
 * 임포트하게 한다. 하나의 공용 루트가 5개 트리를 전부 임포트하면
 * 모든 라우트의 클라이언트 번들에 5개 트리가 다 들어간다 — 1단계에서
 * renderFor 공용 모듈이 Islands를 깨뜨린 것과 같은 함정이다.
 *
 * 데이터 요청의 추가 왕복(셸 → JS → API fetch, 최소 3 RTT)은
 * **의도적으로 남긴 비용**이다. 저대역·고RTT에서 CSR이 불리해지는 주된
 * 이유이고 곧 결정 경계 그 자체이므로, 빠르게 만들면 연구 대상이 사라진다.
 */
export function makeClientRoot(Tree: TreeComponent) {
  return function ClientRoot({ type, routeKey }: { type: string; routeKey: string }) {
    const [data, setData] = useState<never | null>(null)

    useEffect(() => {
      let alive = true
      /*
       * 페이지의 상관 ID를 데이터 요청에 전파한다. API는 별개 요청이라
       * 미들웨어가 새 cid를 발급하고, 그러면 한 페이지뷰의 서버 비용이
       * 두 cid로 흩어져 조인이 끊긴다(2단계).
       */
      const cid = readCorrelationId()

      fetch(`/api/data/${type}/${routeKey}`, {
        headers: cid ? { 'x-correlation-id': cid } : undefined,
      })
        .then((r) => {
          if (!r.ok) throw new Error(`데이터 요청 실패: ${r.status}`)
          return r.json()
        })
        .then((d) => {
          if (alive) setData(d)
        })
        .catch((e) => {
          console.error('[csr] 데이터 로드 실패', e)
        })

      return () => {
        alive = false
      }
    }, [type, routeKey])

    if (!data) return <Skeleton />
    return <Tree data={data} />
  }
}

function readCorrelationId(): string | undefined {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  return nav?.serverTiming?.find((e) => e.name === 'cid')?.description
}
