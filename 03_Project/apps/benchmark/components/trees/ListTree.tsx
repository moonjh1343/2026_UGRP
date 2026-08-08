import { ListRow } from '../leaves/ListRow'
import { FilterChips } from '../widgets/FilterChips'
import type { ListPayload } from '@/lib/data'

/**
 * 목록형 트리. **지시어 없음** — 두 그래프 공용.
 * 지배 축은 DOM 노드 수이므로 항목이 많고 인터랙션은 패싯에 한정된다.
 */
export function ListTree({ data }: { data: ListPayload }) {
  return (
    <div className="list" data-route={data.routeKey}>
      <header>
        <h1>{data.title}</h1>
        <p className="meta">
          <span>{data.totalCount.toLocaleString('ko')}건</span>
        </p>
        <div className="actions">
          {data.facets.map((f) => (
            <FilterChips key={f.id} label={f.label} options={f.options} />
          ))}
        </div>
      </header>

      <ul className="list-items">
        {data.items.map((item) => (
          <ListRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  )
}
