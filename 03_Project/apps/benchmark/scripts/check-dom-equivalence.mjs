/**
 * 1단계 검증: 5개 모드의 **최종 DOM이 동일한가** (설계 문서 §12).
 *
 * 이것이 통과해야 이후 측정된 모드 간 차이를 "렌더 방식의 차이"로 해석할 수 있다.
 * 트리 정의가 갈라져 있으면 그 차이가 코드 차이인지 렌더 방식 차이인지 구분 불가능하다.
 *
 * 사용: npm run build && npm start &  →  npm run check:dom
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const MODES = ['ssr', 'csr', 'stream', 'ssg', 'islands']
const BASELINE = 'ssr'
const ROUTES = process.env.ROUTES?.split(',') ?? ['content-01', 'content-03', 'content-05']

/**
 * 정규 직렬화. innerHTML을 그대로 비교하면 안 되는 이유:
 *
 * innerHTML은 **속성의 삽입 순서**를 보존하는데, 서버에서 파싱된 HTML과
 * 클라이언트에서 createElement로 만든 요소는 그 순서가 다르다.
 * (SSR은 `<img src=… width=…>`, CSR은 `<img width=… src=…>`)
 * DOM 명세상 속성은 순서 없는 맵이므로 이는 실제 차이가 아니다.
 * 따라서 속성을 정렬해 정규형으로 만든 뒤 비교한다.
 *
 * 아래는 모드마다 다른 것이 **정상**이므로 제외한다.
 *   - 주석 노드: Streaming SSR의 Suspense 경계 마커(<!--$-->)
 *   - script/template/style/link: RSC flight data, 부트스트랩 페이로드
 *   - #app-root 자신의 속성: data-mode가 모드마다 다름 → 자식만 비교
 *   - 공백 전용 텍스트 노드
 */
const EXTRACT = () => {
  const root = document.querySelector('#app-root')
  if (!root) return null

  const SKIP = new Set(['script', 'template', 'style', 'link'])
  const out = []

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue.replace(/\s+/g, ' ')
      if (t.trim()) out.push(t)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const tag = node.tagName.toLowerCase()
    if (SKIP.has(tag)) return

    const attrs = Array.from(node.attributes)
      .map((a) => `${a.name}="${a.value}"`)
      .sort()
      .join(' ')

    out.push(`<${tag}${attrs ? ' ' + attrs : ''}>`)
    for (const c of node.childNodes) walk(c)
    out.push(`</${tag}>`)
  }

  for (const c of root.childNodes) walk(c)
  return out.join('')
}

async function capture(page, mode, slug) {
  const url = `${BASE}/m/${mode}/content/${slug}`
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (!res || res.status() !== 200) {
    throw new Error(`${mode}/${slug}: HTTP ${res?.status() ?? 'no response'}`)
  }
  // CSR과 Streaming은 실제 트리가 나중에 도착한다. 스켈레톤이 아니라
  // 최종 트리가 붙을 때까지 기다려야 "최종 DOM" 비교가 된다.
  await page.waitForSelector('#app-root article.content', { timeout: 20_000 })
  await page.waitForLoadState('networkidle')
  const html = await page.evaluate(EXTRACT)
  if (!html) throw new Error(`${mode}/${slug}: #app-root 없음`)
  return html
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const from = Math.max(0, i - 60)
  return {
    index: i,
    baseline: a.slice(from, i + 120),
    actual: b.slice(from, i + 120),
  }
}

const browser = await chromium.launch()
const page = await browser.newPage()

let failed = 0
for (const slug of ROUTES) {
  const captured = {}
  for (const mode of MODES) {
    captured[mode] = await capture(page, mode, slug)
  }

  const base = captured[BASELINE]
  console.log(`\n${slug}  (기준: ${BASELINE}, ${base.length.toLocaleString()}자)`)

  for (const mode of MODES) {
    if (mode === BASELINE) continue
    if (captured[mode] === base) {
      console.log(`  OK    ${mode}`)
    } else {
      failed++
      const d = firstDiff(base, captured[mode])
      console.log(`  FAIL  ${mode} — ${d.index}번째 문자에서 분기`)
      console.log(`        기준: …${d.baseline}…`)
      console.log(`        실제: …${d.actual}…`)
    }
  }
}

await browser.close()

if (failed > 0) {
  console.error(`\n${failed}건 불일치 — 1단계 검증 실패`)
  process.exit(1)
}
console.log('\n전 모드 DOM 동일 — 1단계 검증 통과')
