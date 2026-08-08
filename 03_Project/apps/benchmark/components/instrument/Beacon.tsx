'use client'

import { useEffect } from 'react'
import { onCLS, onINP, onLCP, onTTFB, type MetricWithAttribution } from 'web-vitals/attribution'

/**
 * RUM 수집. 상관 ID를 **Server-Timing 헤더에서** 읽는다.
 *
 * HTML 인라인 주입을 쓰지 않는 이유: SSG·ISR 페이지는 요청 전에 렌더되므로
 * 본문에 요청별 cid를 심을 수 없다. 응답 헤더는 캐시 히트에도 요청마다 새로
 * 붙고 PerformanceServerTiming으로 JS에서 읽히므로, 5개 모드에서 균일하게 동작한다.
 */
export function Beacon() {
  useEffect(() => {
    const ctx = readContext()
    if (!ctx.cid) {
      console.warn('[beacon] Server-Timing에 cid 없음 — 미들웨어를 확인하라')
      return
    }

    const metrics: Record<string, number> = {}
    const attribution: Record<string, unknown> = {}

    const collect = (m: MetricWithAttribution) => {
      metrics[m.name] = m.value
      attribution[m.name] = summarize(m)
    }

    onLCP(collect)
    onINP(collect)
    onCLS(collect)
    onTTFB(collect)

    // TBT는 랩 전용 지표라 web-vitals가 제공하지 않는다. 롱태스크에서 직접 합산한다.
    // (제안서 §3.1의 QoE = {LCP, INP, TBT, TTFB})
    let tbt = 0
    let longTasks = 0
    let observer: PerformanceObserver | undefined
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks++
          tbt += Math.max(0, entry.duration - 50)
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
    } catch {
      // longtask 미지원 브라우저 — TBT는 결측으로 남는다
    }

    let sent = false
    const flush = () => {
      if (sent) return
      sent = true
      observer?.disconnect()

      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined

      const payload = {
        cid: ctx.cid,
        sid: ctx.sid,
        mode: ctx.mode,
        routeKey: ctx.route,
        metrics: {
          ...metrics,
          TBT: tbt,
          longTasks,
          domInteractive: nav?.domInteractive ?? 0,
          transferSize: nav?.transferSize ?? 0,
          encodedBodySize: nav?.encodedBodySize ?? 0,
        },
        attribution,
        hydrationErrors: readHydrationErrors(),
      }

      navigator.sendBeacon('/api/beacon', new Blob([JSON.stringify(payload)], {
        type: 'application/json',
      }))
    }

    // 페이지가 사라지는 시점에 한 번만 보낸다. LCP·INP는 이때 확정된다.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flush)

    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  return null
}

type Ctx = { cid?: string; sid?: string; mode?: string; route?: string }

function readContext(): Ctx {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  const entries = nav?.serverTiming ?? []
  const ctx: Ctx = {}
  for (const e of entries) {
    if (e.name === 'cid') ctx.cid = e.description
    else if (e.name === 'sid') ctx.sid = e.description
    else if (e.name === 'mode') ctx.mode = e.description
    else if (e.name === 'route') ctx.route = e.description
  }
  return ctx
}

/** 하이드레이션 오류율은 서킷 브레이커의 가드레일 지표다(제안서 §3.5) */
function readHydrationErrors(): number {
  return (window as unknown as { __hydrationErrors?: number }).__hydrationErrors ?? 0
}

function summarize(m: MetricWithAttribution): Record<string, unknown> {
  const a = m.attribution as Record<string, unknown>
  // attribution 전체는 무겁다. 모드 간 차이가 **어디서** 생기는지 보는 데
  // 필요한 항목만 추린다(설계 문서 §7).
  return {
    ttfb: a.timeToFirstByte,
    resourceLoadDelay: a.resourceLoadDelay,
    resourceLoadDuration: a.resourceLoadDuration,
    elementRenderDelay: a.elementRenderDelay,
    inputDelay: a.inputDelay,
    processingDuration: a.processingDuration,
    presentationDelay: a.presentationDelay,
    largestShiftTarget: a.largestShiftTarget,
  }
}
