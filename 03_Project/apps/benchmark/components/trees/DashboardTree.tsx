import { KpiTile } from '../leaves/KpiTile'
import { FilterChips } from '../widgets/FilterChips'
import { SortableTable } from '../widgets/SortableTable'
import { SparkChart } from '../widgets/SparkChart'
import type { DashboardPayload } from '@/lib/data'

/**
 * 대시보드형 트리. **지시어 없음** — 두 그래프 공용.
 *
 * 지배 축은 하이드레이션 CPU다. 차트 위젯이 스케일·경로를 클라이언트에서
 * 다시 계산하므로, 전체 하이드레이션 모드(SSR/Stream/CSR)는 서버가 이미
 * 그린 것을 클라이언트에서 반복한다. Islands는 KPI 타일과 레이아웃을
 * 서버에 남기고 차트·필터·표만 섬으로 둔다.
 */
export function DashboardTree({ data }: { data: DashboardPayload }) {
  return (
    <div className="dashboard" data-route={data.routeKey}>
      <header>
        <h1>{data.title}</h1>
        <div className="kpis">
          {data.kpis.map((k) => (
            <KpiTile key={k.id} kpi={k} />
          ))}
        </div>
        <div className="actions">
          {data.filters.map((f) => (
            <FilterChips key={f.id} label={f.label} options={f.options} />
          ))}
        </div>
      </header>

      <div className="charts">
        {data.charts.map((s) => (
          <SparkChart key={s.id} series={s} />
        ))}
      </div>

      <SortableTable columns={data.table.columns} rows={data.table.rows} />
    </div>
  )
}
