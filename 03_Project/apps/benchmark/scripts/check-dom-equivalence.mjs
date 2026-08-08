/**
 * 1단계 검증: 모드별 **최종 DOM이 동일한가** (설계 문서 §12).
 *
 * 이것이 통과해야 이후 측정된 모드 간 차이를 "렌더 방식의 차이"로 해석할 수 있다.
 * 트리 정의가 갈라져 있으면 그 차이가 코드 차이인지 렌더 방식 차이인지 구분 불가능하다.
 *
 * 3단계부터 5개 유형 전체를 검사한다. 유형마다 실행 가능 모드가 다르므로
 * (M(r), 제안서 §3.1.1) 라우트 테이블에서 후보를 읽어 그 안에서만 비교한다.
 *
 * 사용: npm run build && npm start &  →  npm run check:dom
 */
import { chromium } from 'playwright'
import { EXTRACT, READY, loadRoutes, pageUrl, representative } from './_shared.mjs'

const BASELINE = 'ssr'

async function capture(page, mode, type, key) {
  const url = pageUrl(mode, type, key)
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (!res || res.status() !== 200) {
    throw new Error(`${mode}/${type}/${key}: HTTP ${res?.status() ?? 'no response'}`)
  }
  // CSR과 Streaming은 실제 트리가 나중에 도착한다. 스켈레톤이 아니라
  // 최종 트리가 붙을 때까지 기다려야 "최종 DOM" 비교가 된다.
  await page.waitForSelector(READY, { timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  const html = await page.evaluate(EXTRACT)
  if (!html) throw new Error(`${mode}/${type}/${key}: #app-root 없음`)
  return html
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const from = Math.max(0, i - 60)
  return { index: i, baseline: a.slice(from, i + 120), actual: b.slice(from, i + 120) }
}

const { types, routes } = await loadRoutes()
const browser = await chromium.launch()
const page = await browser.newPage()

let failed = 0
let compared = 0

for (const type of types) {
  const route = representative(routes, type)
  const modes = route.candidateModes
  if (!modes.includes(BASELINE)) {
    console.log(`\n${type}/${route.key} — 기준 모드(${BASELINE}) 미지원, 건너뜀`)
    continue
  }

  const captured = {}
  for (const mode of modes) captured[mode] = await capture(page, mode, type, route.key)

  const base = captured[BASELINE]
  console.log(
    `\n${type}/${route.key}  (기준: ${BASELINE}, ${base.length.toLocaleString()}자, 후보 ${modes.length}종)`,
  )

  for (const mode of modes) {
    if (mode === BASELINE) continue
    compared++
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
  console.error(`\n${failed}/${compared}건 불일치 — 1단계 검증 실패`)
  process.exit(1)
}
console.log(`\n${compared}건 비교, 전부 DOM 동일 — 1단계 검증 통과`)
