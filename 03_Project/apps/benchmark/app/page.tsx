import Link from 'next/link'
import { MODES } from '@/lib/modes'
import { ROUTE_TYPES, ROUTES, candidateModes, routesOf, totalCandidateCells } from '@/lib/routes'

/** 수동 확인용 인덱스. 측정 경로가 아니다. */
export default function Index() {
  return (
    <main>
      <h1>적응형 렌더링 벤치마크 (SUT)</h1>
      <p className="meta">
        <span>라우트 {ROUTES.length}종</span>
        <span>모드 {MODES.length}종</span>
        <span>Σ|M(r)| = {totalCandidateCells()}</span>
      </p>

      {ROUTE_TYPES.map((type) => {
        const routes = routesOf(type)
        const excluded = MODES.filter((m) => !candidateModes(routes[0]).includes(m))
        return (
          <section key={type} className="section">
            <h2>
              {type} <small>{routes.length}개 인스턴스</small>
            </h2>
            {excluded.length > 0 ? (
              <p className="help">M(r) 배제: {excluded.join(', ')}</p>
            ) : null}
            <ul className="mode-index">
              {routes.map((r) => (
                <li key={r.key}>
                  <code>{r.key}</code>{' '}
                  {candidateModes(r).map((m) => (
                    <span key={m}>
                      <Link href={`/m/${m}/${type}/${r.key}`}>{m}</Link>{' '}
                    </span>
                  ))}
                  <small className="help">
                    nodes {r.nodeCount} · widgets {r.interactiveCount} · {r.payloadKB}KB
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}
