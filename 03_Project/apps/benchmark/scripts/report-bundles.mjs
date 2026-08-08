/**
 * 모드별 클라이언트 JS 전송량 측정.
 *
 * 두 가지를 확인한다.
 *  1. Islands가 실제로 JS를 덜 보내는가 — 공유 컴포넌트 그래프 기법(설계 문서 §3)이
 *     의도대로 작동했는지의 증거. 트리가 서버 그래프에 남으면 번들에서 빠져야 한다.
 *  2. CSR·SSR·Stream·SSG가 **같은 번들**을 쓰는가 — 경로가 다르면 Next.js가
 *     다른 청크를 낼 수 있고, 그러면 모드 비교가 번들 차이에 오염된다(설계 문서 §11-7).
 *
 * 산출값은 제안서 §3.4의 "모드별 라우트 JS 번들 크기" 피처가 된다.
 *
 * 사용: npm start &  →  node scripts/report-bundles.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const MODES = ['csr', 'ssr', 'stream', 'ssg', 'islands']
const SLUG = process.env.SLUG ?? 'content-03'

async function measure(mode) {
  const res = await fetch(`${BASE}/m/${mode}/content/${SLUG}`)
  const html = await res.text()

  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
  const unique = [...new Set(srcs)]

  let jsBytes = 0
  for (const src of unique) {
    const r = await fetch(new URL(src, BASE))
    jsBytes += (await r.arrayBuffer()).byteLength
  }

  return {
    mode,
    htmlKB: html.length / 1024,
    scripts: unique.length,
    jsKB: jsBytes / 1024,
    chunks: unique.map((s) => s.split('/').pop()).sort(),
  }
}

const rows = []
for (const m of MODES) rows.push(await measure(m))

const pad = (s, n) => String(s).padEnd(n)
const num = (v, n) => v.toFixed(1).padStart(n)

console.log(`\n라우트 ${SLUG} — 모드별 전송량\n`)
console.log(`  ${pad('모드', 10)}${'HTML(KB)'.padStart(10)}${'JS(KB)'.padStart(10)}${'청크'.padStart(8)}`)
console.log(`  ${'-'.repeat(38)}`)
for (const r of rows) {
  console.log(`  ${pad(r.mode, 10)}${num(r.htmlKB, 10)}${num(r.jsKB, 10)}${String(r.scripts).padStart(8)}`)
}

// 1. Islands의 JS가 가장 작아야 한다
const islands = rows.find((r) => r.mode === 'islands')
const ssr = rows.find((r) => r.mode === 'ssr')
const saved = ssr.jsKB - islands.jsKB
console.log(
  `\n  Islands vs SSR: JS ${saved >= 0 ? '-' : '+'}${Math.abs(saved).toFixed(1)}KB ` +
    `(${((saved / ssr.jsKB) * 100).toFixed(1)}% 절감)`,
)

/*
 * 2. 서버 렌더 3종(ssr/stream/ssg)은 청크 집합이 **동일해야** 한다.
 *    셋은 트리를 서버에서 렌더하고 전체 하이드레이션하는 점이 같으므로,
 *    번들이 다르면 그 차이가 모드 비교에 섞인다.
 *
 *    CSR은 제외한다. CSR만 데이터 페처와 스켈레톤이 필요하므로 번들이 큰 것이 정상이고,
 *    그 차이 자체가 CSR의 실제 비용이다.
 */
const serverRendered = rows.filter((r) => ['ssr', 'stream', 'ssg'].includes(r.mode))
const ref = serverRendered[0].chunks.join(',')
const mismatched = serverRendered.filter((r) => r.chunks.join(',') !== ref).map((r) => r.mode)

if (mismatched.length === 0) {
  console.log(`  서버 렌더 3종(ssr/stream/ssg) 청크 집합 동일 — 비교 공정성 확보`)
} else {
  console.log(`  경고: 청크 집합이 다른 모드 — ${mismatched.join(', ')}`)
  for (const r of serverRendered) console.log(`    ${r.mode}: ${r.chunks.join(', ')}`)
}

const csr = rows.find((r) => r.mode === 'csr')
console.log(
  `  CSR 추가분: +${(csr.jsKB - rows.find((r) => r.mode === 'ssr').jsKB).toFixed(1)}KB ` +
    `(데이터 페처 + 스켈레톤 — 정상)`,
)
