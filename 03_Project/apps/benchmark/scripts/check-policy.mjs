/**
 * 4단계 검증: **정책 교체가 앱 코드에 영향을 주지 않는가 / 추론 오버헤드 < 2ms인가**
 * (설계 문서 §12).
 *
 * 검사 항목
 *   A. 경계 — 앱의 렌더 경로가 policy/를 임포트하지 않고, policy/가 앱을 임포트하지 않는다
 *   B. 무개입 — 정책이 무엇을 고르든 렌더 결과는 그 모드의 직접 경로와 **동일 DOM**이다
 *   C. 오버헤드 — Server-Timing policy dur의 p95 < 2ms
 *   D. 실행 가능성 — 어떤 정책도 M(r) 밖의 모드를 적용하지 못하고, 폴백이 기록된다
 *   E. 전환 상한 — 같은 세션·라우트에서 세션당 1회를 넘기면 이전 결정이 유지된다
 *
 * A가 실패하면 정책 비교가 무의미해진다 — 정책마다 앱이 달라지면 무엇을 비교한
 * 것인지 알 수 없다. C가 실패하면 결정 계층 자체가 측정 대상을 왜곡한다.
 *
 * 사용: npm run build && npm start &  →  npm run check:policy
 */
import { readdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { BASE, EXTRACT, READY, loadRoutes, pageUrl } from './_shared.mjs'

const ROOT = new URL('..', import.meta.url)
const N = Number(process.env.REPEATS ?? 200)
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 2)

let failed = 0
const fail = (msg) => {
  failed++
  console.log(`  FAIL  ${msg}`)
}
const ok = (msg) => console.log(`  OK    ${msg}`)

// ---------------------------------------------------------------- A. 경계

/** 앱의 **렌더 경로**. api/internal은 계측 도구라 제외한다(5단계에서 걷어낸다). */
const APP_DIRS = ['app/m', 'components', 'lib/render', 'lib/data']
const POLICY_DIR = 'policy'

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(new URL(dir + '/', ROOT), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

console.log('\nA. 경계 — 정책과 앱이 서로를 임포트하지 않는가\n')

/*
 * 임포트 출처를 넓게 잡는다. `from '...'`(정적)과 `import('...')`(동적) 모두,
 * 경로는 별칭(@/)만이 아니라 상대 경로(../policy)도 본다 — 별칭만 검사하면
 * 상대 임포트 하나로 게이트가 뚫린 채 초록불이 난다.
 */
const importSpecifiers = (src) =>
  [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])

const appFiles = (await Promise.all(APP_DIRS.map(walk))).flat()
const leaks = []
for (const f of appFiles) {
  const src = await readFile(new URL(f, ROOT), 'utf8')
  for (const spec of importSpecifiers(src)) {
    if (spec.startsWith('@/policy') || /(^|\/)policy(\/|$)/.test(spec.replace(/^[./]+/, ''))) {
      leaks.push(`${f} ← ${spec}`)
    }
  }
}
if (leaks.length) fail(`앱 렌더 경로가 policy를 임포트한다: ${leaks.join(', ')}`)
else ok(`앱 렌더 경로 ${appFiles.length}개 파일 — policy 임포트 없음`)

/*
 * Node builtin 목록 — `node:` 접두사 없는 옛 표기도 잡는다. `from 'fs'` 하나가
 * Lambda@Edge 번들에서야 깨지면 게이트가 있었던 의미가 없다.
 */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'worker_threads', 'zlib',
])
const policyFiles = await walk(POLICY_DIR)
const backRefs = []
for (const f of policyFiles) {
  const src = await readFile(new URL(f, ROOT), 'utf8')
  for (const spec of importSpecifiers(src)) {
    // 앱 의존: app·components 전부와, 렌더 경로로 취급하는 @/lib 하위까지.
    // policy가 합법적으로 쓰는 것은 타입·상수 전용 모듈뿐이다: @/lib/modes,
    // @/lib/routes, @/lib/instrument/correlation(헤더·쿠키 이름 정의).
    if (/^@\/(app|components)\//.test(spec)) backRefs.push(`${f} ← ${spec}`)
    else if (/^@\/lib\//.test(spec) && !/^@\/lib\/(modes|routes|instrument\/correlation)$/.test(spec)) {
      backRefs.push(`${f} ← ${spec}`)
    }
    else if (/^\.\.\/(app|components|lib)\//.test(spec)) backRefs.push(`${f} ← ${spec} (상대 경로)`)
    else if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) backRefs.push(`${f} ← ${spec} (Node API)`)
  }
}
if (backRefs.length) fail(`policy/가 앱 또는 Node API에 의존한다: ${backRefs.join(', ')}`)
else ok(`policy/ ${policyFiles.length}개 파일 — 앱·Node 의존 없음`)

// ------------------------------------------------------- 서버 상태 확인

const introspect = await (await fetch(`${BASE}/api/internal/policy`)).json()
const { routes, types } = await loadRoutes()
const routeOf = (type) => routes.filter((r) => r.type === type)[2]

console.log(
  `\n  정책 ${introspect.policies.length}종 · τ=${introspect.tau} · 모델 ${introspect.model.version}` +
    `${introspect.model.fitted ? '' : ' (미학습 자리표시자)'}`,
)
if (!introspect.bundlesGenerated) {
  console.log('  주의: policy/bundles.generated.json이 비어 있다 — npm run analyze:routes 후 재빌드')
}

// ------------------------------------------- B. 무개입 + D. 실행 가능성

console.log('\nB/D. 정책별 적용 모드 — M(r) 준수와 렌더 무개입\n')

const publicUrl = (type, key) => `${BASE}/${type}/${key}`

async function head(type, key, policy) {
  const res = await fetch(publicUrl(type, key), {
    headers: { [`x-policy`]: policy },
    redirect: 'manual',
  })
  await res.arrayBuffer()
  return {
    status: res.status,
    mode: res.headers.get('x-render-mode-applied'),
    reason: res.headers.get('x-decision-reason'),
    margin: res.headers.get('x-decision-margin'),
    policy: res.headers.get('x-policy'),
  }
}

const applied = {}
for (const policy of introspect.policies) {
  const row = []
  for (const type of types) {
    const route = routeOf(type)
    const r = await head(type, route.key, policy)
    applied[`${policy}/${type}`] = r

    if (r.status !== 200) fail(`${policy} × ${type}: HTTP ${r.status}`)
    else if (!route.candidateModes.includes(r.mode)) {
      fail(`${policy} × ${type}: M(r) 밖의 모드 적용 — ${r.mode} ∉ {${route.candidateModes}}`)
    }
    row.push(`${type.slice(0, 4)}=${r.mode}${r.reason === 'policy' ? '' : `(${r.reason})`}`)
  }
  console.log(`  ${policy.padEnd(15)}${row.join('  ')}`)
}

// 폴백이 실제로 발생하고 기록되는가 — fixed-ssg는 개인화 라우트에서 성립하지 않는다
const ssgOnPersonalized = applied['fixed-ssg/personalized']
if (ssgOnPersonalized?.reason === 'infeasible') {
  ok(`fixed-ssg × personalized → ${ssgOnPersonalized.mode} (infeasible 기록됨)`)
} else {
  fail(`fixed-ssg × personalized가 infeasible로 기록되지 않았다: ${ssgOnPersonalized?.reason}`)
}

/*
 * 크롤러 고정. SEO는 모델이 건드리지 않는다.
 *
 * 동시에 **헤드리스 브라우저는 봇이 아니어야 한다.** 측정 워커가 헤드리스 Chrome이므로
 * 봇으로 잡히면 모든 워커 요청이 SSR로 고정되어 정책 비교 자체가 성립하지 않는다.
 */
{
  const GOOGLEBOT =
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  const HEADLESS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'

  const asBot = await fetch(publicUrl('dashboard', routeOf('dashboard').key), {
    headers: { 'x-policy': 'fixed-csr', 'user-agent': GOOGLEBOT },
  })
  await asBot.arrayBuffer()
  if (asBot.headers.get('x-decision-reason') === 'bot' && asBot.headers.get('x-render-mode-applied') === 'ssr') {
    ok('크롤러 UA → ssr 고정 (fixed-csr을 덮어씀)')
  } else {
    fail(
      `크롤러 UA가 SSR로 고정되지 않았다: ${asBot.headers.get('x-render-mode-applied')} ` +
        `(${asBot.headers.get('x-decision-reason')})`,
    )
  }

  const asWorker = await fetch(publicUrl('dashboard', routeOf('dashboard').key), {
    headers: { 'x-policy': 'fixed-csr', 'user-agent': HEADLESS },
  })
  await asWorker.arrayBuffer()
  if (asWorker.headers.get('x-decision-reason') === 'bot') {
    fail('헤드리스 브라우저가 봇으로 분류됐다 — 측정 워커의 모든 요청이 SSR로 고정된다')
  } else {
    ok(`헤드리스 브라우저는 봇이 아니다 → ${asWorker.headers.get('x-render-mode-applied')}`)
  }
}

const marginHit = Object.entries(applied).filter(([, r]) => r.reason === 'margin')
console.log(
  `  마진 폴백 ${marginHit.length}건 / ${Object.keys(applied).length}건 ` +
    `(τ=${introspect.tau} — 상위 두 모드 차가 이보다 작으면 전환하지 않는다)`,
)

// ------------------------------------------------ B. DOM 동등성 (브라우저)

console.log('\nB. 공개 URL의 최종 DOM = 적용된 모드의 직접 경로 DOM\n')

const browser = await chromium.launch()

async function capture(ctx, url) {
  const page = await ctx.newPage()
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (!res || res.status() !== 200) throw new Error(`${url}: HTTP ${res?.status()}`)
  await page.waitForSelector(READY, { timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  const html = await page.evaluate(EXTRACT)
  const mode = res.headers()['x-render-mode-applied'] ?? null
  await page.close()
  return { html, mode }
}

for (const type of types) {
  const route = routeOf(type)
  for (const policy of ['fixed-csr', 'fixed-islands', 'surrogate']) {
    // 세션마다 컨텍스트를 분리한다 — __dec 쿠키가 남으면 전환 상한이 끼어든다
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-policy': policy } })
    const viaPolicy = await capture(ctx, publicUrl(type, route.key))
    await ctx.close()

    const direct = await browser.newContext()
    const viaDirect = await capture(direct, pageUrl(viaPolicy.mode, type, route.key))
    await direct.close()

    if (viaPolicy.html === viaDirect.html) {
      ok(`${type.padEnd(13)} ${policy.padEnd(14)} → ${viaPolicy.mode} (DOM 동일)`)
    } else {
      fail(
        `${type} × ${policy} → ${viaPolicy.mode}: 공개 URL과 직접 경로의 DOM이 다르다 ` +
          `(${viaPolicy.html?.length} vs ${viaDirect.html?.length}자)`,
      )
    }
  }
}

// ---------------------------------------------------- E. 세션 전환 상한

console.log('\nE. 세션 전환 상한 (세션·라우트당 1회)\n')
{
  const ctx = await browser.newContext()
  const route = routeOf('content')
  /*
   * ssr → csr → stream. 1회차는 확정, 2회차는 전환 1회(허용), 3회차는 상한에 걸려
   * 2회차 모드가 유지되어야 한다. 브라우저 컨텍스트를 공유해야 __dec 쿠키가 이어진다.
   */
  const seq = ['fixed-ssr', 'fixed-csr', 'fixed-stream']
  const seen = []
  for (const policy of seq) {
    // 헤더는 컨텍스트 단위다 — 요청 직전에 갈아끼운다
    await ctx.setExtraHTTPHeaders({ 'x-policy': policy })
    const page = await ctx.newPage()
    const res = await page.goto(publicUrl('content', route.key), { waitUntil: 'domcontentloaded' })
    seen.push({
      policy,
      mode: res.headers()['x-render-mode-applied'],
      reason: res.headers()['x-decision-reason'],
    })
    await page.close()
  }
  await ctx.close()

  console.log(`  ${seen.map((s) => `${s.policy}→${s.mode}(${s.reason})`).join('  ')}`)
  /*
   * 세 단계 모두 단언한다. "session-cap이라는 사유가 어딘가에 있다"만 보면
   * 상한이 0으로 굳은 서버(2회차부터 cap, 전환이 아예 불가능)도 통과한다 —
   * 명세는 "2회차는 전환 1회 허용, 3회차는 2회차 모드 유지"다.
   */
  const [first, second, third] = seen
  if (second.mode !== 'csr' || second.reason === 'session-cap') {
    fail(`2회차가 csr로 전환되지 않았다 (${second.mode}, ${second.reason}) — 상한이 1이 아니라 0으로 동작한다`)
  } else if (third.reason !== 'session-cap') {
    fail(`3회차에서 전환 상한이 발동하지 않았다 (${third.mode}, ${third.reason}) — ssr→csr로 이미 1회 전환했다`)
  } else if (third.mode !== second.mode) {
    fail(`상한 발동 시 유지된 모드가 2회차와 다르다 (${second.mode} → ${third.mode})`)
  } else {
    ok(`전환 1회 허용 후 상한 발동 — ${third.mode} 유지 (${first.mode}→${second.mode}→${third.mode})`)
  }
}

await browser.close()

// ------------------------------------------------------- C. 추론 오버헤드

console.log(`\nC. 추론 오버헤드 — 정책별 ${N}회, 예산 ${BUDGET_MS}ms\n`)

function parsePolicyDur(header) {
  // Server-Timing: policy;dur=0.123;desc="policy"
  const m = /(?:^|,)\s*policy;dur=([0-9.]+)/.exec(header ?? '')
  return m ? Number(m[1]) : NaN
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
}

const route = routeOf('dashboard')
for (const policy of introspect.policies) {
  const durs = []
  // 워밍업 — JIT과 서버 상태 캐시가 데워진 뒤부터 잰다
  for (let i = 0; i < 5; i++) {
    await (await fetch(publicUrl('dashboard', route.key), { headers: { 'x-policy': policy } })).arrayBuffer()
  }
  for (let i = 0; i < N; i++) {
    const res = await fetch(publicUrl('dashboard', route.key), { headers: { 'x-policy': policy } })
    await res.arrayBuffer()
    const d = parsePolicyDur(res.headers.get('server-timing'))
    if (Number.isFinite(d)) durs.push(d)
  }
  if (durs.length < N * 0.9) {
    fail(`${policy}: Server-Timing policy 항목이 ${durs.length}/${N}회만 잡혔다`)
    continue
  }
  const p50 = pct(durs, 0.5)
  const p95 = pct(durs, 0.95)
  const max = Math.max(...durs)
  const verdict = p95 < BUDGET_MS ? 'OK  ' : 'FAIL'
  if (p95 >= BUDGET_MS) failed++
  console.log(
    `  ${verdict}  ${policy.padEnd(15)}` +
      `p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  max=${max.toFixed(3)}ms`,
  )
}

/*
 * 강제 지정 경로는 정책을 태우지 않아야 한다. factorial 수집은 8,800셀 × 30회이므로
 * 여기에 불필요한 추론이 얹히면 그 자체가 서버 부하 피처를 오염시킨다.
 */
{
  const res = await fetch(pageUrl('ssr', 'dashboard', route.key))
  await res.arrayBuffer()
  const d = parsePolicyDur(res.headers.get('server-timing'))
  if (Number.isFinite(d)) fail(`/m/ 직접 경로에서 정책이 실행됐다 (dur=${d}ms)`)
  else ok('/m/ 직접 경로는 정책을 우회한다 (factorial 수집 경로)')
}

// ----------------------------------------------------------------- 결과

if (failed > 0) {
  console.error(`\n${failed}건 실패 — 4단계 검증 실패`)
  process.exit(1)
}
console.log('\n경계·무개입·실행 가능성·오버헤드 전부 통과 — 4단계 검증 통과')
if (!introspect.model.fitted) {
  console.log(
    '단, 서러게이트는 미학습 자리표시자다. 검증된 것은 결정 계층의 배선과 비용이지 정책의 품질이 아니다.',
  )
}
