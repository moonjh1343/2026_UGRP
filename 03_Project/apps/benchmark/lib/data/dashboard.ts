import { seeded } from '../rng'
import type { Route } from '../routes'
import { METRIC_LABELS, NOUNS, TAGS, UNITS } from './lexicon'
import { clamp } from './shared'
import type { DashboardPayload, Series } from './types'

/** 차트 하나가 그리는 SVG 노드 수(포인트 + 축 + 눈금) */
const NODES_PER_CHART = 180
const POINTS_PER_SERIES = 120

/**
 * 대시보드형 — **하이드레이션 CPU**가 지배 축이다.
 *
 * 차트 위젯이 하이드레이션 시점에 스케일·눈금·SVG 경로를 계산하므로,
 * 인터랙티브 컴포넌트 수가 곧 클라이언트 CPU 비용이 된다. SSR은 HTML을
 * 다 그려 보내고도 이 계산을 클라이언트에서 다시 하므로 비용을 두 번 낸다.
 * Islands는 트리를 서버에 남기고 차트만 섬으로 두어 이 비용을 줄인다.
 */
export function generateDashboard(route: Route): DashboardPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  // 인터랙티브 위젯의 절반은 차트, 나머지는 필터·정렬
  const chartCount = clamp(Math.round(route.interactiveCount * 0.6), 2, 24)
  const filterCount = clamp(route.interactiveCount - chartCount, 1, 12)
  const tableRows = clamp(
    Math.round((route.nodeCount - chartCount * NODES_PER_CHART) / 8),
    5,
    300,
  )

  const charts: Series[] = Array.from({ length: chartCount }, (_, i) => ({
    id: `chart-${i + 1}`,
    label: rng.pick(METRIC_LABELS),
    unit: rng.pick(UNITS),
    // 결정적 시계열. 추세 + 계절성 + 시드 노이즈로 현실적인 모양을 만든다.
    points: Array.from({ length: POINTS_PER_SERIES }, (_, t) => {
      const trend = t * 0.6
      const seasonal = Math.sin((t / POINTS_PER_SERIES) * Math.PI * 6) * 18
      const noise = (rng.next() - 0.5) * 12
      return Math.round((40 + trend + seasonal + noise) * 100) / 100
    }),
  }))

  const kpis = Array.from({ length: 4 }, (_, i) => ({
    id: `kpi-${i + 1}`,
    label: rng.pick(METRIC_LABELS),
    value: rng.int(100, 99_999),
    delta: Math.round((rng.next() - 0.5) * 400) / 10,
    unit: rng.pick(UNITS),
  }))

  const filters = Array.from({ length: filterCount }, (_, i) => ({
    id: `filter-${i + 1}`,
    label: rng.pick(NOUNS),
    options: Array.from({ length: 4 }, () => rng.pick(TAGS)),
  }))

  const columns = ['ID', '항목', '값', '변화', '상태']
  const rows = Array.from({ length: tableRows }, (_, i) => [
    `r-${String(i + 1).padStart(3, '0')}`,
    `${rng.pick(NOUNS)} ${i + 1}`,
    rng.int(0, 10_000),
    Math.round((rng.next() - 0.5) * 200) / 10,
    rng.pick(['정상', '주의', '경고']),
  ])

  return {
    routeType: 'dashboard',
    routeKey: route.key,
    title: `운영 대시보드 — ${route.key}`,
    kpis,
    charts,
    filters,
    table: { columns, rows },
  }
}
