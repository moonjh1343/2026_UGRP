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

/**
 * 부하 수준의 기준이 되는 **할당 코어 수**.
 *
 * 제안서 §5.2의 "서버 부하 30/65/90% CPU"는 컨테이너의 CPU 사용률을 뜻하고,
 * Fargate에서는 태스크에 할당된 vCPU 대비 비율이다. 이것을 머신 전체 코어 수로 나누면
 * **단일 스레드 Node 프로세스는 원리적으로 목표에 도달할 수 없다** — 18코어 머신에서
 * 상한이 100/18 ≈ 5.6%가 되어 30%조차 불가능하다. 실제로 캘리브레이션이 이렇게 깨졌다.
 *
 * SUT는 `next start` 단일 프로세스이므로 기본값은 1이다. Fargate에서 `cpu=2048`처럼
 * 여러 vCPU를 주면 `SUT_CPU_CORES`로 맞춘다. **실험 메타데이터에 반드시 기록해야 하는
 * 값이다** — 이 값이 다르면 "부하 65%"가 다른 것을 뜻한다.
 */
const ALLOCATED_CORES = Math.max(1, Number(process.env.SUT_CPU_CORES ?? 1) || 1)

export type ServerSnapshot = {
  /** 할당 CPU 대비 사용률(%). 머신 전체가 아니라 ALLOCATED_CORES 기준이다 */
  cpuPct: number
  /** cpuPct의 분모. 다른 환경의 값과 비교하려면 이 값이 같아야 한다 */
  allocatedCores: number
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

  /*
   * 히스토그램도 CPU와 같은 "조회 사이의 델타" 의미론이다. 리셋 없이 두면
   * 프로세스 일생 누적 분포가 되어, high 부하 셀을 지난 뒤의 idle 셀에서도
   * p95가 높게 남는다 — 서버 상태 피처가 측정 이력에 의존하는 계통 오염이고,
   * 조건 순서 무작위화로도 상쇄되지 않는다.
   */
  const histP95 = s.histogram.percentile(95) / 1e6
  const histMax = s.histogram.max / 1e6
  s.histogram.reset()

  const mem = process.memoryUsage()

  return {
    cpuPct: Math.min(100, (usedUs / elapsedUs / ALLOCATED_CORES) * 100),
    allocatedCores: ALLOCATED_CORES,
    memPct: (mem.rss / os.totalmem()) * 100,
    rssMB: mem.rss / 1024 / 1024,
    inflight: s.inflight,
    eventLoopP95Ms: histP95,
    eventLoopMaxMs: histMax,
    cacheHitRate: cacheHitRate(),
    routeRps: routeRps(),
    guardrails: guardrails(),
    cpuCount,
    ts: now,
  }
}
