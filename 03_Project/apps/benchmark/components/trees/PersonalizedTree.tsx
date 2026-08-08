import { FilterChips } from '../widgets/FilterChips'
import type { PersonalizedPayload } from '@/lib/data'

/**
 * 개인화형 트리. **지시어 없음** — 두 그래프 공용.
 *
 * shared(캐시 가능)와 personalized(캐시 불가)를 시각적으로도 분리해 둔다.
 * personalizedRatio = 1.0이라 SSG 후보에서 배제되므로(제안서 §3.1.1),
 * 이 유형의 결정 경계는 서버 부하 축에서 나타난다.
 */
export function PersonalizedTree({ data }: { data: PersonalizedPayload }) {
  return (
    <div className="personalized" data-route={data.routeKey}>
      <header>
        <h1>{data.title}</h1>
        <p className="greeting">{data.personalized.greeting}</p>
        <div className="actions">
          <FilterChips label="보기" options={['전체', '추천', '최근']} />
        </div>
      </header>

      <section className="shared" id="shared">
        <h2>{data.shared.heading}</h2>
        {data.shared.blurbs.map((b, i) => (
          <p key={i}>{b}</p>
        ))}
      </section>

      <section className="recs" id="recs">
        <h2>추천</h2>
        <ol>
          {data.personalized.recommendations.map((r) => (
            <li key={r.id}>
              <span className="rec-title">{r.title}</span>
              <span className="rec-score">{r.score.toFixed(1)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="activity" id="activity">
        <h2>최근 활동</h2>
        <ul>
          {data.personalized.activity.map((a) => (
            <li key={a.id}>
              <span>{a.label}</span>
              <time dateTime={a.at}>{a.at}</time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
