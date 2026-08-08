/**
 * C_render(m) 산출 — 제안서 §3.1.2의 ServerCost 첫 항.
 *
 * **per-request CPU 측정은 신뢰할 수 없다.** process.cpuUsage()의 해상도가
 * 플랫폼 타이머에 묶여 있어(Windows 15.625ms) 수 ms짜리 렌더는 0 또는
 * 한 틱으로 양자화된다. Linux는 getrusage 기반이라 훨씬 정밀하지만,
 * 밀리초 미만 렌더는 여전히 노이즈 바닥에 가깝다.
 *
 * 따라서 C_render는 **N회 반복의 총 CPU ÷ N**으로 구한다. 제안서 §5.2가
 * 셀당 30회 반복을 규정하는 것과 같은 이유이며, 개별 요청 값은 진단용으로만 쓴다.
 *
 * 사용: npm start &  →  npm run measure:render
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const N = Number(process.env.N ?? 60)
const WARMUP = Number(process.env.WARMUP ?? 5)
const SLUG = process.env.SLUG ?? 'content-03'

/*
 * SSG는 캐시 히트 시 렌더하지 않으므로 여기서 제외한다. SSG의 C_render는
 * 재검증 시점 1회 비용이고, 요청당 비용은 missRate로 환산된다(제안서 §3.1.2).
 */
const MODES = ['csr', 'ssr', 'stream', 'islands']

async function measure(mode) {
  const url =
    mode === 'csr'
      ? `${BASE}/api/data/content/${SLUG}` // CSR의 서버 비용 본체는 데이터 경로다
      : `${BASE}/m/${mode}/content/${SLUG}`

  // 워밍업 — JIT·커넥션 풀 안정화 (제안서 §5.2 측정 프로토콜)
  for (let i = 0; i < WARMUP; i++) await fetch(url)

  await fetch(`${BASE}/api/internal/records`, { method: 'DELETE' })

  const walls = []
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const res = await fetch(url)
    await res.arrayBuffer()
    walls.push(performance.now() - t0)
  }

  const dump = await (await fetch(`${BASE}/api/internal/records`)).json()
  const mine = dump.renders.filter((r) => r.mode === mode)
  const totalCpuUs = mine.reduce((s, r) => s + r.cpuUs, 0)
  const totalRenderWall = mine.reduce((s, r) => s + r.wallMs, 0)

  walls.sort((a, b) => a - b)

  return {
    mode,
    samples: mine.length,
    cRenderUs: mine.length ? totalCpuUs / mine.length : NaN,
    renderWallMs: mine.length ? totalRenderWall / mine.length : NaN,
    e2eP50: walls[Math.floor(walls.length * 0.5)],
    e2eP95: walls[Math.floor(walls.length * 0.95)],
  }
}

const rows = []
for (const m of MODES) rows.push(await measure(m))

const n = (v, w, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w)

console.log(`\n라우트 ${SLUG} — C_render 산출 (N=${N}, 워밍업 ${WARMUP})\n`)
console.log(
  `  ${'모드'.padEnd(10)}${'표본'.padStart(6)}${'C_render(µs)'.padStart(14)}` +
    `${'렌더 wall(ms)'.padStart(14)}${'e2e p50(ms)'.padStart(13)}${'e2e p95(ms)'.padStart(13)}`,
)
console.log(`  ${'-'.repeat(70)}`)
for (const r of rows) {
  console.log(
    `  ${r.mode.padEnd(10)}${String(r.samples).padStart(6)}${n(r.cRenderUs, 14, 0)}` +
      `${n(r.renderWallMs, 14, 2)}${n(r.e2eP50, 13, 1)}${n(r.e2eP95, 13, 1)}`,
  )
}

const quantized = rows.every((r) => r.cRenderUs === 0 || !Number.isFinite(r.cRenderUs))
if (quantized) {
  console.log(
    `\n  경고: 총 CPU가 0으로 집계됐다. N을 키우거나(N=${N * 5}) 더 무거운 라우트를 쓰라.`,
  )
} else {
  console.log(`\n  집계 기반이므로 개별 요청의 타이머 양자화가 상쇄된다.`)
}
