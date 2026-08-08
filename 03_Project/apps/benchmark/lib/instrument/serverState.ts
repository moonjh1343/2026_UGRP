import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import os from 'node:os'
import { cacheHitRate, guardrails, routeRps } from './store'

/**
 * 서버 상태 스냅샷. 제안서 §3.4의 서버 상태 피처를 산출한다.
 *
 * 결정 계층은 이 값을 30초 주기로 캐시해 쓴다. 요청마다 조회하면 그 왕복이
 * TTFB에 얹혀 측정 대상 자체를 왜곡한다(제안서 §6.7).
 */

type State = {
  histogram: IntervalHistogram
  lastCpu: NodeJS.CpuUsage
  lastAt: number
  inflight: number
}

declare global {
  // eslint-disable-next-line no-var
  var __ugrpServerState: State | undefined
}

function state(): State {
  if (!globalThis.__ugrpServerState) {
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    globalThis.__ugrpServerState = {
      histogram,
      lastCpu: process.cpuUsage(),
      lastAt: Date.now(),
      inflight: 0,
    }
  }
  return globalThis.__ugrpServerState
}

export function enterRequest() {
  state().inflight++
}

export function exitRequest() {
  const s = state()
  s.inflight = Math.max(0, s.inflight - 1)
}

export type ServerSnapshot = {
  cpuPct: number
  memPct: number
  rssMB: number
  inflight: number
  /**
   * 이벤트 루프 지연 p95(ms). 프로세스 단위 지표라 동시 요청 오염 문제가 없고,
   * "렌더 큐 지연" 피처의 실체가 된다.
   */
  eventLoopP95Ms: number
  eventLoopMaxMs: number
  cacheHitRate: number
  /** 라우트별 최근 60초 요청률 — 전역 rps로는 라우트별 캐시 효율을 반영 못 한다 */
  routeRps: Record<string, number>
  /** 서킷 브레이커 입력. 결정 계층이 같은 왕복으로 가져간다(제안서 §3.5) */
  guardrails: { hydrationErrorRate: number; errorRate5xx: number }
  cpuCount: number
  ts: number
}

export function snapshot(): ServerSnapshot {
  const s = state()
  const now = Date.now()
  const cpu = process.cpuUsage()
  const elapsedUs = Math.max(1, (now - s.lastAt) * 1000)
  const usedUs = cpu.user - s.lastCpu.user + (cpu.system - s.lastCpu.system)
  const cpuCount = os.cpus().length

  s.lastCpu = cpu
  s.lastAt = now

  const mem = process.memoryUsage()

  return {
    cpuPct: Math.min(100, (usedUs / elapsedUs / cpuCount) * 100),
    memPct: (mem.rss / os.totalmem()) * 100,
    rssMB: mem.rss / 1024 / 1024,
    inflight: s.inflight,
    eventLoopP95Ms: s.histogram.percentile(95) / 1e6,
    eventLoopMaxMs: s.histogram.max / 1e6,
    cacheHitRate: cacheHitRate(),
    routeRps: routeRps(),
    guardrails: guardrails(),
    cpuCount,
    ts: now,
  }
}
