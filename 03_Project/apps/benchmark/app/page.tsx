import Link from 'next/link'
import { MODES } from '@/lib/modes'
import { ROUTES, candidateModes, totalCandidateCells } from '@/lib/routes'

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

      {ROUTES.map((r) => {
        const allowed = candidateModes(r)
        return (
          <section key={r.key} className="section">
            <h2>
              {r.key}{' '}
              <small>
                nodeCount {r.nodeCount} · payload {r.payloadKB}KB · widgets {r.interactiveCount}
              </small>
            </h2>
            <ul className="mode-index">
              {MODES.map((m) => (
                <li key={m}>
                  {allowed.includes(m) ? (
                    <Link href={`/m/${m}/content/${r.key}`}>
                      /m/{m}/content/{r.key}
                    </Link>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>
                      /m/{m}/content/{r.key} — M(r) 배제
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}
