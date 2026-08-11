/**
 * 모드별 클라이언트 그래프에 **무엇이 들어 있는지** 확인한다.
 *
 * 총 번들 크기는 React/Next 런타임(~550KB)이 지배해서 앱 코드 차이가 묻힌다.
 * 따라서 크기가 아니라 마커 문자열의 포함 여부로 그래프 경계를 검증한다.
 *
 * 기대: Islands에는 트리가 없고 위젯만 있어야 한다.
 *
 * 사용: npm start &  →  npm run inspect:graph [TYPE=dashboard]
 */
import { BASE, loadRoutes, pageUrl, representative } from './_shared.mjs'

/**
 * 각 모듈이 컴파일·최소화된 뒤에도 남는 **고유** 문자열.
 * 'section'·'note' 같은 흔한 단어는 다른 코드에도 나타나 거짓 양성을 낸다.
 */
const MARKERS = {
  '트리 루트': 'data-route',
  '리프(Figure/KpiTile)': 'figcaption|kpi-delta',
  '차트 계산(scale.ts)': 'largest-contentful|niceTicks|Catmull|areaPath|chart-hint',
  '위젯(토글류)': 'aria-expanded|aria-pressed',
  '폼 검증': '형식이 올바르지 않습니다',
  '스켈레톤': 'aria-busy',
  'CSR 페처': '/api/data/',
}

async function inspect(mode, type, key) {
  const html = await (await fetch(pageUrl(mode, type, key))).text()
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]

  let js = ''
  for (const s of srcs) js += await (await fetch(new URL(s, BASE))).text()

  const found = {}
  for (const [label, pattern] of Object.entries(MARKERS)) {
    found[label] = pattern.split('|').some((p) => js.includes(p))
  }
  return { mode, found, kb: js.length / 1024 }
}

const { routes } = await loadRoutes()
const type = process.env.TYPE ?? 'dashboard'
const route = representative(routes, type)
if (!route) throw new Error(`알 수 없는 유형: ${type}`)

const rows = []
for (const m of route.candidateModes) rows.push(await inspect(m, type, route.key))

const labels = Object.keys(MARKERS)
const w = Math.max(...labels.map((l) => l.length + 2), 22)

console.log(`\n${type}/${route.key} — 클라이언트 그래프 내용\n`)
console.log(`  ${''.padEnd(w)}${rows.map((r) => r.mode.padStart(9)).join('')}`)
console.log(`  ${'-'.repeat(w + 9 * rows.length)}`)
for (const label of labels) {
  const cells = rows.map((r) => (r.found[label] ? '있음' : '없음').padStart(9))
  console.log(`  ${label.padEnd(w)}${cells.join('')}`)
}
console.log(`  ${'JS(KB)'.padEnd(w)}${rows.map((r) => r.kb.toFixed(1).padStart(9)).join('')}`)

const islands = rows.find((r) => r.mode === 'islands')
const ssr = rows.find((r) => r.mode === 'ssr')

console.log('')
if (!islands || !ssr) {
  console.log('  ?    islands 또는 ssr 후보가 없어 비교 불가')
} else if (!islands.found['트리 루트'] && ssr.found['트리 루트']) {
  const saved = ssr.kb - islands.kb
  console.log(
    `  OK   Islands 클라이언트 그래프에 트리 없음 — 경계 심 기법 작동 ` +
      `(JS ${saved >= 0 ? '-' : '+'}${Math.abs(saved).toFixed(1)}KB)`,
  )
} else if (islands.found['트리 루트']) {
  console.log('  FAIL Islands 번들에 트리가 포함됨 — 서버 그래프에 머물지 못했다')
  // FAIL을 출력만 하고 exit 0이면 CI에서 잡을 방법이 없다 — 경계 심 회귀가 통과한다.
  process.exitCode = 1
  console.log('       모드별 렌더 모듈이나 페이지 파일이 *.client를 임포트하는지 확인하라')
} else {
  console.log('  ?    SSR 번들에도 트리가 없다 — 마커 문자열이 컴파일에서 사라졌을 수 있다')
}
