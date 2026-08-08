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
    onTTFB(collect)
    /*
     * INP·CLS는 reportAllChanges로 받는다.
     *
     * 기본값(false)에서는 페이지가 숨겨질 때 **한 번만** 확정하는데, 측정 워커가 다른 URL로
     * 이동하면 pagehide만 발화하는 경우가 있어 그 확정이 flush와 경쟁한다. LCP는 자체 폴백
     * 관측자로 막았지만 INP·CLS에는 폴백이 없어, 상호작용을 주입했는데도 값이 결측됐다
     * (5단계 스모크 테스트에서 INP가 전부 null이었다).
     *
     * reportAllChanges는 갱신될 때마다 콜백을 부르므로 flush 시점에 항상 최신값이 있다.
     * INP는 정의상 관측된 상호작용들의 요약이라 중간값도 유효하며, 마지막 보고가
     * 확정값과 같다.
     */
    onINP(collect, { reportAllChanges: true })
    onCLS(collect, { reportAllChanges: true })

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

    /*
     * LCP 폴백 관측자.
     *
     * web-vitals의 onLCP는 (첫 사용자 입력 | 페이지 숨김) 중 먼저 오는 시점에 확정한다.
     * 상호작용이 없는 페이지에서는 확정이 visibilitychange를 기다리는데, 측정 워커가
     * 다른 URL로 이동하면 pagehide만 발화하는 경우가 있어 **flush와 경쟁**한다.
     * 실제로 폼형에서 LCP만 결측됐다(TTFB·TBT는 정상 수집).
     *
     * 마지막 LCP 후보를 직접 들고 있다가, web-vitals 값이 없으면 이 값을 쓴다.
     * getEntriesByType('largest-contentful-paint')는 항상 비어 있으므로
     * buffered PerformanceObserver가 유일한 경로다.
     */
    /*
     * INP 폴백 관측자.
     *
     * onINP만으로는 이 앱에서 INP가 **거의 항상 결측**된다. 원인이 두 겹이다.
     *  1. `event` 타이밍은 durationThreshold(web-vitals 기본 40ms) 미만이면 엔트리가
     *     아예 전달되지 않는다. 여기 위젯은 토글·입력뿐이라 대부분 그보다 빠르다.
     *  2. 엔트리가 없으면 reportAllChanges도 부를 것이 없고, 확정은 페이지 숨김을
     *     기다리는데 그 시점은 flush와 경쟁한다.
     *
     * 그래서 직접 관측한다. 임계값은 16ms(명세상 하한)로 낮추고, 그보다도 빠른 경우는
     * `performance.interactionCount`로 "상호작용은 있었으나 임계값 미만"임을 구분한다.
     * **값을 지어내지 않는 것**이 핵심이다 — 상호작용이 아예 없었던 경우와
     * 빨라서 안 잡힌 경우는 다른 사실이다.
     */
    let inpFallback = 0
    let inpEntries = 0
    let inpObserver: PerformanceObserver | undefined
    try {
      inpObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          if (!e.interactionId) continue
          inpEntries++
          inpFallback = Math.max(inpFallback, e.duration)
        }
      })
      inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 })
    } catch {
      // event timing 미지원 — web-vitals 값에만 의존한다
    }

    let lcpFallback = NaN
    let lcpObserver: PerformanceObserver | undefined
    try {
      lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1]
        if (last) lcpFallback = last.startTime
      })
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch {
      // 미지원 브라우저 — web-vitals 값에만 의존한다
    }

    let sent = false
    const flush = () => {
      if (sent) return
      sent = true
      observer?.disconnect()
      lcpObserver?.disconnect()
      inpObserver?.disconnect()

      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined

      // web-vitals가 확정하지 못했으면 폴백 관측자의 마지막 후보를 쓴다
      if (typeof metrics.LCP !== 'number' && Number.isFinite(lcpFallback)) {
        metrics.LCP = lcpFallback
        attribution.LCP = { source: 'fallback-observer' }
      }

      /*
       * INP 폴백. 세 경우를 구분한다.
       *   - 임계값 이상 상호작용이 있었다  → 그 최댓값
       *   - 상호작용은 있었으나 전부 16ms 미만 → 0 (사실이다: 반응이 임계값보다 빨랐다)
       *   - 상호작용이 아예 없었다        → 결측으로 남긴다 (0이 아니다)
       */
      const interactionCount =
        (performance as Performance & { interactionCount?: number }).interactionCount ?? 0
      if (typeof metrics.INP !== 'number') {
        if (inpEntries > 0) {
          metrics.INP = inpFallback
          attribution.INP = { source: 'fallback-observer', entries: inpEntries }
        } else if (interactionCount > 0) {
          metrics.INP = 0
          attribution.INP = { source: 'below-threshold', interactionCount }
        }
      }

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

      writeSessionProfile(metrics.LCP, tbt)

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

/**
 * 세션 프로파일 쿠키 — 콜드 스타트 대응 (제안서 §3.4, 설계 문서 §7).
 *
 * 최초 요청에는 기기 정밀 피처가 없다. deviceMemory·hardwareConcurrency는
 * Client Hints로 다 오지 않고(hardwareConcurrency는 대응 힌트가 아예 없다),
 * 이전 페이지뷰의 실측 LCP·TBT는 어떤 헤더로도 오지 않는다. 브라우저가 아는 것을
 * 브라우저가 적어 보내는 것이 유일한 경로다.
 *
 * 결정 계층은 이 값을 다음 요청부터 피처로 쓴다. 즉 **첫 페이지뷰는 항상
 * 콜드 스타트**이고, 그 사실 자체가 실험에서 통제해야 할 조건이다.
 */
function writeSessionProfile(lcp: number | undefined, tbt: number) {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number }
    const profile = {
      lcp: typeof lcp === 'number' ? Math.round(lcp) : undefined,
      tbt: Math.round(tbt),
      dm: nav.deviceMemory,
      hc: navigator.hardwareConcurrency,
    }
    const value = encodeURIComponent(btoa(JSON.stringify(profile)))
    document.cookie = `__prof=${value}; path=/; max-age=1800; samesite=lax`
  } catch {
    // 쿠키를 못 쓰면 콜드 스타트가 지속될 뿐, 결정은 계속 가능하다
  }
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
