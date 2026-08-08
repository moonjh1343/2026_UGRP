import type { DashboardPayload } from '@/lib/data'

/** 지시어 없음 — 두 그래프 공용. 인터랙션이 없으므로 Islands에서 JS가 나가지 않는다. */
export function KpiTile({ kpi }: { kpi: DashboardPayload['kpis'][number] }) {
  const up = kpi.delta >= 0
  return (
    <div className="kpi" data-trend={up ? 'up' : 'down'}>
      <span className="kpi-label">{kpi.label}</span>
      <strong className="kpi-value">
        {kpi.value.toLocaleString('ko')}
        <small>{kpi.unit}</small>
      </strong>
      <span className="kpi-delta">
        {up ? '▲' : '▼'} {Math.abs(kpi.delta).toFixed(1)}%
      </span>
    </div>
  )
}
