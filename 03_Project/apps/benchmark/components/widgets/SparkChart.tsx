'use client'

import { useMemo, useState } from 'react'
import { buildGeometry, movingAverage } from '@/lib/chart/scale'
import type { Series } from '@/lib/data'

const WIDTH = 320
const HEIGHT = 120

/**
 * 대시보드형의 하이드레이션 비용 원천.
 *
 * 스케일·눈금·SVG 경로 계산이 **하이드레이션 시점에 클라이언트에서 다시** 실행된다.
 * SSR은 이 HTML을 서버에서 그려 보내고도 클라이언트에서 같은 계산을 반복하므로
 * 비용을 두 번 낸다. Islands는 트리를 서버에 남기고 이 위젯만 섬으로 두어 줄인다.
 *
 * 초기 렌더는 서버·클라이언트가 반드시 동일해야 하므로 useState 초기값을
 * 고정하고 브라우저 API에 의존하지 않는다.
 */
export function SparkChart({ series }: { series: Series }) {
  const [smooth, setSmooth] = useState(false)
  const [hover, setHover] = useState<number | null>(null)

  const geometry = useMemo(() => {
    const values = smooth ? movingAverage(series.points, 7) : series.points
    return buildGeometry(values, WIDTH, HEIGHT)
  }, [series.points, smooth])

  const latest = series.points[series.points.length - 1] ?? 0

  return (
    <figure className="chart" data-chart={series.id}>
      <figcaption>
        <span className="chart-label">{series.label}</span>
        <span className="chart-value">
          {latest.toFixed(1)}
          {series.unit}
        </span>
        <button type="button" aria-pressed={smooth} onClick={() => setSmooth((s) => !s)}>
          부드럽게
        </button>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${series.label} 추이`}
        onMouseLeave={() => setHover(null)}
      >
        {geometry.yTicks.map((t) => (
          <g key={`y${t.y}`}>
            <line x1={34} y1={t.y} x2={WIDTH - 8} y2={t.y} className="grid" />
            <text x={30} y={t.y + 3} textAnchor="end" className="tick">
              {t.label}
            </text>
          </g>
        ))}
        {geometry.xTicks.map((t) => (
          <text key={`x${t.x}`} x={t.x} y={HEIGHT - 4} textAnchor="middle" className="tick">
            {t.label}
          </text>
        ))}

        <path d={geometry.areaPath} className="area" />
        <path d={geometry.linePath} className="line" />

        {geometry.points.map((p, i) =>
          i % 8 === 0 ? (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={hover === i ? 3.5 : 1.8}
              className="dot"
              onMouseEnter={() => setHover(i)}
            />
          ) : null,
        )}
      </svg>

      <p className="chart-hint">
        {hover === null ? ' ' : `${hover}: ${geometry.points[hover]?.v.toFixed(1)}`}
      </p>
    </figure>
  )
}
