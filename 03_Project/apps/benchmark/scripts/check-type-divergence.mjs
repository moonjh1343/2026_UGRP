/**
 * 3단계 검증: **유형별 모드 우열이 서로 다른 방향인가** (설계 문서 §12).
 *
 * 다섯 유형이 전부 같은 모드를 선호하면 적응형 정책이 학습할 결정 경계가 없다.
 * 그 경우 연구 전제가 성립하지 않으므로, 유형별 비용 노브(설계 문서 §5)를
 * 재조정해야 한다.
 *
 * **지표는 2단계 비콘 파이프라인에서 읽는다.** 스크립트가 직접
 * performance.getEntriesByType()을 호출하면 안 된다 — longtask와 LCP는
 * PerformanceObserver 없이 타임라인에 남지 않아 전부 0/NaN이 나온다.
 * 앱의 Beacon이 web-vitals로 수집한 값을 레코드에서 조회한다.
 *
 * **스로틀링이 없으면 의미가 없다.** 로컬의 빠른 CPU와 무제한 대역폭에서는
 * 모든 모드가 비슷하게 보인다. 5단계 측정 워커의 최소 버전이다.
 *
 * 사용: npm run build && npm start &  →  npm run check:divergence
 */
import { chromium } from 'playwright'
import { BASE, READY, loadRoutes, median, pageUrl, representative } from './_shared.mjs'

/** 제안서 부록 B의 기기·네트워크 등급 중 결정 경계가 잘 드러나는 조합 */
const CPU_THROTTLE = Number(process.env.CPU ?? 4) // Low tier
const NET = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // 3G Fast
  uploadThroughput: (0.75 * 1024 * 1024) / 8,
  latency: 150,
}
const REPEATS = Number(process.env.REPEATS ?? 3)

/** 목적함수 대리 — 제안서 §3.1의 QoE 가중합을 단순화한 랩 지표 */
function score(m) {
  return m.lcp + m.tbt * 2
}

async function visit(browser, mode, type, key) {
  // 반복마다 컨텍스트를 새로 만든다 — 콜드 캐시 고정(제안서 §5.2)
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  await cdp.send('Network.emulateNetworkConditions', NET)

  await page.goto(pageUrl(mode, type, key), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(READY, { timeout: 90_000 })
  await page.waitForLoadState('networkidle')

  /*
   * INP는 상호작용이 없으면 발생하지 않는다. 유형마다 존재하는 컨트롤이 다르므로
   * 후보를 넓게 시도한다 — 폼형에는 .toc/.chips가 없어 초기 목록으로는
   * 상호작용이 하나도 일어나지 않았다.
   */
  for (const sel of [
    '.toc button',
    '.share button',
    '.chips button',
    '.data-table th button',
    '.chart button',
    '.field input',
  ]) {
    await page.click(sel, { timeout: 1200 }).catch(() => {})
  }
  await page.waitForTimeout(150)

  // 페이지를 떠나며 pagehide → sendBeacon 이 발화한다.
  await page.goto('about:blank')
  await page.waitForTimeout(250)
  await ctx.close()
}

const { types, routes } = await loadRoutes()
await fetch(`${BASE}/api/internal/records`, { method: 'DELETE' })

const browser = await chromium.launch()
const plan = []

for (const type of types) {
  const route = representative(routes, type)
  for (const mode of route.candidateModes) {
    for (let i = 0; i < REPEATS; i++) await visit(browser, mode, type, route.key)
    plan.push({ type, key: route.key, mode, route })
  }
}

await browser.close()
await new Promise((r) => setTimeout(r, 600))

const dump = await (await fetch(`${BASE}/api/internal/records`)).json()

function collect(mode, key) {
  const bs = dump.beacons.filter((b) => b.mode === mode && b.routeKey === key)
  return {
    mode,
    samples: bs.length,
    lcp: median(bs.map((b) => b.metrics.LCP).filter(Number.isFinite)),
    tbt: median(bs.map((b) => b.metrics.TBT).filter(Number.isFinite)),
  }
}

console.log(`\nCPU ${CPU_THROTTLE}× 스로틀 · 3G Fast · 반복 ${REPEATS}회 (중앙값)\n`)

const winners = {}
let missing = 0

for (const type of types) {
  const route = representative(routes, type)
  const rows = route.candidateModes.map((m) => collect(m, route.key))
  const usable = rows.filter((r) => Number.isFinite(r.lcp))
  if (usable.length === 0) {
    missing++
    console.log(`${type}/${route.key} — 비콘 미수집\n`)
    continue
  }

  usable.sort((a, b) => score(a) - score(b))
  winners[type] = usable[0].mode

  console.log(
    `${type}/${route.key}  (widgets ${route.interactiveCount}, ${route.payloadKB}KB, nodes ${route.nodeCount})`,
  )
  for (const r of usable) {
    console.log(
      `  ${r.mode.padEnd(9)} n=${r.samples}  LCP=${String(Math.round(r.lcp)).padStart(5)}ms  ` +
        `TBT=${String(Math.round(r.tbt)).padStart(5)}ms  점수=${Math.round(score(r))}`,
    )
  }
  console.log(`  → 최우수: ${usable[0].mode}\n`)
}

const distinct = new Set(Object.values(winners))

console.log('유형별 최우수 모드')
for (const [type, mode] of Object.entries(winners)) console.log(`  ${type.padEnd(14)} ${mode}`)

if (missing > 0) {
  console.error(`\n${missing}개 유형에서 비콘이 수집되지 않았다 — 계측을 먼저 확인하라`)
  process.exit(1)
}

if (distinct.size <= 1) {
  console.error(
    `\n모든 유형이 같은 모드(${[...distinct][0]})를 선호한다 — 3단계 검증 실패.\n` +
      `학습할 결정 경계가 없다. 설계 문서 §5의 유형별 비용 노브를 재조정하라.`,
  )
  process.exit(1)
}

console.log(
  `\n서로 다른 최우수 모드 ${distinct.size}종(${[...distinct].join(', ')}) — 3단계 검증 통과`,
)
