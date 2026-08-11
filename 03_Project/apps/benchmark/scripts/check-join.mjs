/**
 * 2단계 검증: **서버 레코드와 클라이언트 비콘이 100% 조인되는가** (설계 문서 §12).
 *
 * 렌더 결정은 서버에서, 성능 측정은 브라우저에서 일어난다. 이 둘을 상관 ID로
 * 잇지 못하면 데이터셋이 통째로 쓸모없어진다 — 데이터 무결성의 급소다.
 *
 * 검증 항목
 *   1. 응답 헤더의 cid == 브라우저 JS가 읽은 cid  (5개 모드 전부)
 *   2. 그 cid로 비콘이 도착했는가
 *   3. 비콘에 QoE 지표(LCP/TTFB/TBT)가 실려 있는가
 *   4. 서버 렌더 레코드가 같은 cid로 존재하는가 (SSG 캐시 히트는 예외 — 아래 참조)
 *
 * 사용: npm run build && npm start &  →  npm run check:join
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const MODES = ['csr', 'ssr', 'stream', 'ssg', 'islands']
const SLUG = process.env.SLUG ?? 'content-01'

await fetch(`${BASE}/api/internal/records`, { method: 'DELETE' })

const browser = await chromium.launch()
const results = []

for (const mode of MODES) {
  // 세션을 모드마다 분리한다 — 세션 쿠키가 섞이면 sid 조인을 검증할 수 없다.
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  const res = await page.goto(`${BASE}/m/${mode}/content/${SLUG}`, { waitUntil: 'load' })
  const headerCid = res.headers()['x-correlation-id']
  const nextCache = res.headers()['x-nextjs-cache'] ?? null

  await page.waitForSelector('#app-root article.content', { timeout: 20_000 })

  // INP는 상호작용이 없으면 발생하지 않는다. 결정적 시퀀스를 주입한다.
  // 워커의 상호작용 시퀀스(설계 문서 §7)의 최소 버전이다.
  await page.click('.toc button').catch(() => {})
  await page.click('.share button').catch(() => {})
  await page.waitForTimeout(120)

  const jsCid = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    return nav?.serverTiming?.find((e) => e.name === 'cid')?.description ?? null
  })

  // 페이지를 떠나며 pagehide → sendBeacon 이 발화한다.
  await page.goto('about:blank')
  await page.waitForTimeout(300)
  await ctx.close()

  results.push({ mode, headerCid, jsCid, nextCache })
}

await browser.close()
await new Promise((r) => setTimeout(r, 500))

const dump = await (await fetch(`${BASE}/api/internal/records`)).json()
const beaconByCid = new Map(dump.beacons.map((b) => [b.cid, b]))
const rendersByCid = new Map()
for (const r of dump.renders) {
  if (!r.cid) continue
  rendersByCid.set(r.cid, [...(rendersByCid.get(r.cid) ?? []), r])
}

let failed = 0
/*
 * TBT도 필수다. 이 게이트의 주장이 "LCP/TTFB/TBT 검증"인데 TBT를 출력만 하고
 * 요구하지 않으면, longtask 관측자 회귀가 2단계를 통과하고 — 3단계의 승자 판정도
 * TBT 유한성 검사에 걸리기 전까지는 같은 결측을 연달아 놓친다.
 * INP는 요구하지 않는다: 상호작용→next-paint 타이밍이 확정되기 전에 페이지를
 * 떠나면 정당하게 결측일 수 있어, 여기서 강제하면 게이트가 불안정해진다.
 */
const REQUIRED_METRICS = ['LCP', 'TTFB', 'TBT']

console.log(`\n라우트 ${SLUG} — 상관 ID 조인 검증\n`)

for (const { mode, headerCid, jsCid, nextCache } of results) {
  const problems = []

  if (!headerCid) problems.push('응답 헤더에 cid 없음')
  if (!jsCid) problems.push('브라우저가 Server-Timing에서 cid를 못 읽음')
  if (headerCid && jsCid && headerCid !== jsCid) problems.push('헤더 cid ≠ JS cid')

  const beacon = jsCid ? beaconByCid.get(jsCid) : undefined
  if (!beacon) problems.push('비콘 미도착')
  else {
    const missing = REQUIRED_METRICS.filter((m) => typeof beacon.metrics[m] !== 'number')
    if (missing.length) problems.push(`지표 결측: ${missing.join(',')}`)
    if (beacon.mode !== mode) problems.push(`비콘 mode 불일치: ${beacon.mode}`)
    if (beacon.hydrationErrors > 0) problems.push(`하이드레이션 오류 ${beacon.hydrationErrors}건`)
  }

  const renders = jsCid ? (rendersByCid.get(jsCid) ?? []) : []
  /*
   * SSG는 요청 전에 렌더되므로 캐시 히트 요청에는 렌더 레코드가 없다.
   * 이는 결함이 아니라 SSG의 정의이며, 제안서 §3.1.2의 missRate가 재는 것이 바로 이것이다.
   */
  const ssgCacheHit = mode === 'ssg' && nextCache && nextCache.toUpperCase() !== 'MISS'
  if (renders.length === 0 && !ssgCacheHit) problems.push('서버 렌더 레코드 없음')

  /*
   * 렌더 CPU는 여기서 표시하지 않는다. process.cpuUsage()의 해상도가 플랫폼
   * 타이머에 묶여 있어(Windows 15.625ms) 수 ms짜리 렌더는 0으로 양자화된다.
   * C_render는 반복 집계로 산출한다 — npm run measure:render.
   */
  const wallMs = renders.reduce((s, r) => s + r.wallMs, 0)
  const lcp = beacon?.metrics?.LCP
  const tbt = beacon?.metrics?.TBT

  const status = problems.length === 0 ? 'OK  ' : 'FAIL'
  if (problems.length) failed++

  console.log(
    `  ${status} ${mode.padEnd(8)} ` +
      `렌더레코드=${String(renders.length).padStart(2)} ` +
      `렌더wall=${wallMs.toFixed(1).padStart(5)}ms ` +
      `LCP=${lcp ? Math.round(lcp) + 'ms' : '-'} `.padEnd(11) +
      `TBT=${tbt !== undefined ? Math.round(tbt) + 'ms' : '-'} `.padEnd(10) +
      `cache=${nextCache ?? '-'}`,
  )
  for (const p of problems) console.log(`         ! ${p}`)
}

console.log(
  `\n  비콘 ${dump.beacons.length}건 / 렌더 레코드 ${dump.renders.length}건 수집`,
)
console.log(`  렌더 CPU는 양자화로 per-request 측정이 불가 — C_render는 measure:render로 산출`)

if (failed > 0) {
  console.error(`\n${failed}개 모드 조인 실패 — 2단계 검증 실패`)
  process.exit(1)
}
console.log('\n전 모드 조인 성립 — 2단계 검증 통과')
