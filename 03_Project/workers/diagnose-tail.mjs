/**
 * 두꺼운 꼬리의 원인 진단.
 *
 * 5단계에서 콘텐츠형만 이상치 제거율이 24%였다(대시보드 3%, 폼 1%). MAD가 작은데
 * 제거율이 높다는 것은 분포가 넓은 게 아니라 **두 개로 갈렸다**는 뜻이다.
 * 이 스크립트는 무엇이 갈렸는지 찾는다.
 *
 * 판정 순서
 *   1. LCP 요소가 실행마다 바뀌는가 — 바뀌면 같은 셀에서 서로 다른 두 사건을 잰 것이다
 *   2. 바뀌지 않는다면, 분해된 구간(TTFB / 리소스 로드 / 렌더 지연) 중 어디가 튀는가
 *
 * 1번이 참이면 통제되지 않은 축은 "LCP 후보의 정체성"이고, 해결책은 셀을 나누는 게
 * 아니라 **후보가 하나로 확정되게 만드는 것**이다.
 *
 * 사용: npm run build && npm start &  →  node diagnose-tail.mjs --type content
 */
import { chromium } from 'playwright'
import { loadRouteTable, makeRng, shuffle } from './lib/grid.mjs'
import { arg } from './lib/args.mjs'
import { measureOnce } from './lib/measure.mjs'
import { mad, median, removeOutliers } from './lib/stats.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

const TYPE = arg('type', 'content')
const REPS = Number(arg('reps', 30))
const WARMUP = Number(arg('warmup', 3))
const DEVICE = arg('device', 'low')
const NETWORK = arg('network', '3g-fast')
/** 기본은 ssg 제외 — ssg 셀의 캐시 준비(revalidate)가 만드는 여파를 후보에서 분리한다 */
const MODES = (arg('modes', 'ssr,stream,islands') ?? '').split(',')

const table = await loadRouteTable(BASE)
const of = table.routes.filter((r) => r.type === TYPE)
const route = of[Math.floor(of.length / 2)]
if (!route) {
  console.error(`알 수 없는 유형: ${TYPE}`)
  process.exit(1)
}

const modes = MODES.filter((m) => route.candidateModes.includes(m))
const browser = await chromium.launch()

console.log(`\n두꺼운 꼬리 진단 — ${TYPE}/${route.key}`)
console.log(`  ${DEVICE} · ${NETWORK} · 모드 ${modes.join(', ')} · 반복 ${REPS}회\n`)

const rng = makeRng('diagnose')
const plan = shuffle(
  modes.flatMap((mode) =>
    Array.from({ length: REPS + WARMUP }, (_, i) => ({
      cell: {
        device: DEVICE,
        network: NETWORK,
        load: 'idle',
        routeType: TYPE,
        routeKey: route.key,
        mode,
        cache: 'n/a',
      },
      rep: i - WARMUP,
    })),
  ),
  rng,
)

const rows = []
let n = 0
process.stdout.write('  ')
for (const { cell, rep } of plan) {
  /*
   * run.mjs·verify-variance와 같은 이유로 잡는다 — Playwright의 일시적 타임아웃
   * 한 번으로 30~60분짜리 진단이 통째로 죽으면 안 된다.
   */
  let r
  try {
    r = await measureOnce({ base: BASE, browser, cell, rep, allowStale: false })
  } catch (err) {
    r = { ok: false, reason: `예외: ${err.message}` }
  }
  if (!r.ok || rep < 0) continue
  const a = r.attribution?.LCP ?? {}
  rows.push({
    mode: cell.mode,
    lcp: r.metrics.LCP,
    tbt: r.metrics.TBT,
    target: a.target ?? '(미기록)',
    url: a.url ?? '',
    ttfb: a.ttfb ?? NaN,
    loadDelay: a.resourceLoadDelay ?? NaN,
    loadDur: a.resourceLoadDuration ?? NaN,
    renderDelay: a.elementRenderDelay ?? NaN,
  })
  if (++n % 20 === 0) process.stdout.write('.')
}
process.stdout.write('\n\n')
await browser.close()

if (rows.length === 0) {
  console.error('유효 표본이 없다')
  process.exit(1)
}

// ─────────────────────────────────────────── 1. LCP 요소가 갈리는가

const byTarget = new Map()
for (const r of rows) {
  const key = r.target + (r.url ? ` ← ${r.url.split('/').pop()}` : '')
  if (!byTarget.has(key)) byTarget.set(key, [])
  byTarget.get(key).push(r.lcp)
}

console.log(`  LCP 요소별 분포 (표본 ${rows.length})`)
console.log(`    ${'요소'.padEnd(38)}${'n'.padStart(5)}${'중앙값'.padStart(9)}${'MAD'.padStart(7)}`)
const targets = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [key, xs] of targets) {
  console.log(
    `    ${key.slice(0, 36).padEnd(38)}${String(xs.length).padStart(5)}` +
      `${median(xs).toFixed(0).padStart(9)}${mad(xs).toFixed(0).padStart(7)}`,
  )
}

const split = targets.length > 1
console.log('')
if (split) {
  const gap = Math.abs(median(targets[0][1]) - median(targets[1][1]))
  console.log(
    `  → LCP 요소가 ${targets.length}종으로 갈린다. 상위 두 요소의 중앙값 차이 ${gap.toFixed(0)}ms.`,
  )
  console.log('    같은 셀 안에서 서로 다른 두 사건을 재고 있다 — 통제되지 않은 축이 여기다.')
} else {
  console.log('  → LCP 요소는 하나로 고정된다. 원인은 요소 정체성이 아니다.')
}

// ─────────────────────────────────── 2. 어느 모드가 꼬리를 만드는가

/*
 * **이상치는 반드시 모드별로 계산한다.**
 *
 * 모드를 합쳐서 계산하면 CSR(~2400)과 나머지(~750)가 한 분포에 섞여 MAD 트리밍이
 * 대량으로 잘라내고, 그 수치는 데이터가 아니라 집계 방식이 만든 것이 된다.
 * verify-variance.mjs가 모드별로 계산하므로 여기서도 같아야 비교가 성립한다.
 * 첫 구현이 합쳐서 계산했고, 그 탓에 A/B 비교가 통째로 무효였다.
 */
const modeRows = new Map()
for (const r of rows) {
  if (!modeRows.has(r.mode)) modeRows.set(r.mode, [])
  modeRows.get(r.mode).push(r)
}

console.log(`  모드별 종합 점수와 이상치 (LCP + 2·TBT)`)
console.log(
  `    ${'모드'.padEnd(9)}${'n'.padStart(5)}${'중앙값'.padStart(9)}${'MAD'.padStart(8)}${'이상치'.padStart(9)}`,
)
let totalOut = 0
let totalN = 0
for (const [mode, rs] of modeRows) {
  const xs = rs.map((r) => r.lcp + 2 * r.tbt).filter(Number.isFinite)
  const { removed } = removeOutliers(xs)
  totalOut += removed.length
  totalN += xs.length
  console.log(
    `    ${mode.padEnd(9)}${String(xs.length).padStart(5)}${median(xs).toFixed(0).padStart(9)}` +
      `${mad(xs).toFixed(1).padStart(8)}` +
      `${(removed.length + '/' + xs.length).padStart(9)}`,
  )
}
console.log(
  `\n  모드별 합산 이상치율 ${((totalOut / totalN) * 100).toFixed(0)}% (${totalOut}/${totalN})` +
    ` — 5단계 본 검증의 24%와 같은 방식으로 계산한 값이다`,
)

// ─────────────────────────────── 3. 모드별 LCP 구간 분해

console.log(`\n  모드별 요소 렌더 지연 — LCP의 지배 구간`)
console.log(
  `    ${'모드'.padEnd(9)}${'중앙값'.padStart(9)}${'MAD'.padStart(8)}${'최대'.padStart(9)}${'TTFB중앙'.padStart(10)}`,
)
for (const [mode, rs] of modeRows) {
  const rd = rs.map((r) => r.renderDelay).filter(Number.isFinite)
  const tt = rs.map((r) => r.ttfb).filter(Number.isFinite)
  if (rd.length === 0) continue
  console.log(
    `    ${mode.padEnd(9)}${median(rd).toFixed(0).padStart(9)}${mad(rd).toFixed(1).padStart(8)}` +
      `${Math.max(...rd).toFixed(0).padStart(9)}${median(tt).toFixed(0).padStart(10)}`,
  )
}
console.log('')
