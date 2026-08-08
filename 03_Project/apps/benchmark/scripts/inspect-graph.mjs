/**
 * 모드별 클라이언트 그래프에 **무엇이 들어 있는지** 확인한다.
 *
 * 총 번들 크기는 React/Next 런타임(~550KB)이 지배해서 앱 코드 차이가 묻힌다.
 * 따라서 크기가 아니라 마커 문자열의 포함 여부로 그래프 경계를 검증한다.
 *
 * 기대: Islands에는 트리가 없고 위젯만 있어야 한다.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const MODES = ['csr', 'ssr', 'stream', 'ssg', 'islands']
const SLUG = process.env.SLUG ?? 'content-03'

/**
 * 각 모듈이 컴파일·최소화된 뒤에도 남는 **고유** 문자열.
 * 'section'·'note' 같은 흔한 단어는 다른 코드에도 나타나 거짓 양성을 낸다.
 */
const MARKERS = {
  '트리(ContentTree)': 'data-route',
  '리프(Figure)': 'figcaption',
  '위젯(TocToggle)': 'aria-expanded',
  '위젯(ShareButton)': 'data-count',
  '스켈레톤': 'aria-busy',
  'CSR 페처': '/api/data/',
}

async function inspect(mode) {
  const html = await (await fetch(`${BASE}/m/${mode}/content/${SLUG}`)).text()
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]

  let js = ''
  for (const s of srcs) js += await (await fetch(new URL(s, BASE))).text()

  const found = {}
  for (const [label, marker] of Object.entries(MARKERS)) found[label] = js.includes(marker)
  return { mode, found, bytes: js.length }
}

const rows = []
for (const m of MODES) rows.push(await inspect(m))

const labels = Object.keys(MARKERS)
const w = Math.max(...labels.map((l) => l.length)) + 2

console.log(`\n라우트 ${SLUG} — 클라이언트 그래프 내용\n`)
console.log(`  ${''.padEnd(w)}${MODES.map((m) => m.padStart(9)).join('')}`)
console.log(`  ${'-'.repeat(w + 9 * MODES.length)}`)
for (const label of labels) {
  const cells = rows.map((r) => (r.found[label] ? '있음' : '없음').padStart(9))
  console.log(`  ${label.padEnd(w)}${cells.join('')}`)
}

const islands = rows.find((r) => r.mode === 'islands')
const ssr = rows.find((r) => r.mode === 'ssr')

console.log('')
if (!islands.found['트리(ContentTree)'] && ssr.found['트리(ContentTree)']) {
  console.log('  OK   Islands 클라이언트 그래프에 트리 없음 — 경계 심 기법 작동')
} else if (islands.found['트리(ContentTree)']) {
  console.log('  FAIL Islands 번들에 트리가 포함됨 — 서버 그래프에 머물지 못했다')
  console.log('       모드별 렌더 모듈 중 하나가 ContentTree.client를 임포트하는지 확인하라')
} else {
  console.log('  ?    SSR 번들에도 트리가 없다 — 마커 문자열이 컴파일에서 사라졌을 수 있다')
}
