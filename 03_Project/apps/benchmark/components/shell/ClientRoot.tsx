'use client'

import { useEffect, useState } from 'react'
import ContentTree from '../trees/ContentTree.client'
import { Skeleton } from './Skeleton'
import type { ContentPayload } from '@/lib/data'

/**
 * CSR 진입점. 셸만 전송되고 데이터는 클라이언트가 HTTP로 가져온다.
 *
 * 이 추가 왕복(셸 → JS → API fetch, 최소 3 RTT)은 **의도적으로 남긴 비용**이다.
 * 저대역·고RTT에서 CSR이 불리해지는 주된 이유이고 곧 결정 경계 그 자체이므로,
 * API를 인위적으로 빠르게 만들면 연구 대상이 사라진다(설계 문서 §3).
 */
export function ClientRoot({ type, routeKey }: { type: string; routeKey: string }) {
  const [data, setData] = useState<ContentPayload | null>(null)

  useEffect(() => {
    let alive = true
    /*
     * 페이지의 상관 ID를 데이터 요청에 전파한다.
     *
     * CSR의 서버 비용은 셸 렌더 + 이 API 호출로 나뉘는데, API 요청은 별도 요청이라
     * 미들웨어에서 **새 cid**를 받는다. 전파하지 않으면 한 페이지뷰의 서버 비용이
     * 두 cid로 흩어져 조인이 끊긴다.
     */
    const cid = readCorrelationId()

    fetch(`/api/data/${type}/${routeKey}`, {
      headers: cid ? { 'x-correlation-id': cid } : undefined,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`데이터 요청 실패: ${r.status}`)
        return r.json()
      })
      .then((d: ContentPayload) => {
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
  return <ContentTree data={data} />
}

function readCorrelationId(): string | undefined {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  return nav?.serverTiming?.find((e) => e.name === 'cid')?.description
}
