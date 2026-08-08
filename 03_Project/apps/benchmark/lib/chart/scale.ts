/**
 * 차트 계산 모듈. 대시보드형 라우트만 임포트한다.
 *
 * 이 모듈이 존재하는 이유는 **컴포넌트 코드 무게를 유형별로 다르게** 만들기
 * 위해서다. 데이터 크기(payloadKB)만 조절하면 번들 크기는 모든 라우트가
 * 같아지고, 제안서 §3.4의 "모드별 라우트 JS 번들 크기" 피처에 분산이 없어진다.
 *
 * 계산은 하이드레이션 시점에 클라이언트에서 다시 실행된다 — SSR이 HTML을
 * 다 그려 보내고도 비용을 두 번 내는 지점이 바로 여기다.
 */

export type Scale = {
  domain: [number, number]
  range: [number, number]
  map(v: number): number
  invert(p: number): number
  ticks(count: number): number[]
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1

  return {
    domain,
    range,
    map: (v) => r0 + ((v - d0) / span) * (r1 - r0),
    invert: (p) => d0 + ((p - r0) / (r1 - r0 || 1)) * span,
    ticks: (count) => niceTicks(d0, d1, count),
  }
}

/** 사람이 읽기 좋은 눈금 간격 — 1·2·5·10 계열로 반올림한다 */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo]
  const rawStep = (hi - lo) / Math.max(1, count)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalized = rawStep / magnitude

  let step: number
  if (normalized <= 1) step = magnitude
  else if (normalized <= 2) step = 2 * magnitude
  else if (normalized <= 5) step = 5 * magnitude
  else step = 10 * magnitude

  const start = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 0.5; v += step) {
    out.push(Math.round(v * 1e6) / 1e6)
  }
  return out
}

export function extent(values: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) return [0, 1]
  // 상하 5% 여백 — 선이 축에 붙지 않게 한다
  const pad = (hi - lo) * 0.05 || 1
  return [lo - pad, hi + pad]
}

export type ChartGeometry = {
  linePath: string
  areaPath: string
  points: { x: number; y: number; v: number }[]
  xTicks: { x: number; label: string }[]
  yTicks: { y: number; label: string }[]
  width: number
  height: number
}

const PAD = { top: 8, right: 8, bottom: 18, left: 34 }

/**
 * 시계열 → SVG 기하. 하이드레이션마다 실행되는 실제 계산 비용이다.
 */
export function buildGeometry(
  values: number[],
  width: number,
  height: number,
): ChartGeometry {
  const x = linearScale([0, Math.max(1, values.length - 1)], [PAD.left, width - PAD.right])
  const y = linearScale(extent(values), [height - PAD.bottom, PAD.top])

  const points = values.map((v, i) => ({ x: x.map(i), y: y.map(v), v }))

  // Catmull-Rom 근사 곡선 — 점마다 제어점을 계산한다
  let linePath = ''
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i === 0) {
      linePath += `M${round(p.x)},${round(p.y)}`
      continue
    }
    const prev = points[i - 1]
    const cx = (prev.x + p.x) / 2
    linePath += `C${round(cx)},${round(prev.y)} ${round(cx)},${round(p.y)} ${round(p.x)},${round(p.y)}`
  }

  const baseline = height - PAD.bottom
  const areaPath =
    points.length > 0
      ? `${linePath}L${round(points[points.length - 1].x)},${round(baseline)}` +
        `L${round(points[0].x)},${round(baseline)}Z`
      : ''

  const yTicks = y.ticks(4).map((v) => ({ y: round(y.map(v)), label: formatTick(v) }))
  const xTicks = x.ticks(5).map((v) => ({ x: round(x.map(v)), label: String(Math.round(v)) }))

  return { linePath, areaPath, points, xTicks, yTicks, width, height }
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

export function formatTick(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  if (abs >= 10) return v.toFixed(0)
  return v.toFixed(1)
}

/** 이동평균 — 위젯의 "부드럽게" 토글이 하이드레이션 후 재계산을 유발한다 */
export function movingAverage(values: number[], window: number): number[] {
  if (window <= 1) return values
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    out.push(sum / Math.min(i + 1, window))
  }
  return out
}
