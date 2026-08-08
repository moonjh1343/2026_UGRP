import type { ListItem } from '@/lib/data'

/** 지시어 없음 — 두 그래프 공용. 목록형 DOM 노드 수의 대부분을 차지한다. */
export function ListRow({ item }: { item: ListItem }) {
  return (
    <li className="list-row" id={item.id}>
      <div className="list-main">
        <h3>
          {item.title}
          {item.badge ? <span className="badge">{item.badge}</span> : null}
        </h3>
        <p className="summary">{item.summary}</p>
        <ul className="tags">
          {item.tags.map((t, i) => (
            <li key={`${t}-${i}`}>{t}</li>
          ))}
        </ul>
      </div>
      <div className="list-side">
        <span className="price">{item.price.toLocaleString('ko')}원</span>
        <span className="rating">{item.rating.toFixed(1)}</span>
      </div>
    </li>
  )
}
