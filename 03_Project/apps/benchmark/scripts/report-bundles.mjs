/**
 * 모드별 클라이언트 JS 전송량 측정. 유형 전체를 훑는다.
 *
 * 두 가지를 확인한다.
 *  1. Islands가 실제로 JS를 덜 보내는가 — 공유 컴포넌트 그래프 기법(설계 문서 §3)이
 *     의도대로 작동했는지의 증거.
 *  2. 서버 렌더 3종(ssr/stream/ssg)이 **같은 번들**을 쓰는가 — 다르면 그 차이가
 *     모드 비교에 섞인다(설계 문서 §11-7). CSR은 페처·스켈레톤이 추가되므로
 *     더 큰 것이 정상이고, 그 차이 자체가 CSR의 실제 비용이다.
 *
 * 산출값은 제안서 §3.4의 "모드별 라우트 JS 번들 크기" 피처가 된다.
 *
 * 사용: npm start &  →  npm run report:bundles
 */
import { BASE, loadRoutes, pageUrl, representative } from './_shared.mjs'

async function measure(mode, type, key) {
  const html = await (await fetch(pageUrl(mode, type, key))).text()
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]

  let jsBytes = 0
  for (const src of srcs) {
    jsBytes += (await (await fetch(new URL(src, BASE))).arrayBuffer()).byteLength
  }

  return {
    mode,
    htmlKB: html.length / 1024,
    jsKB: jsBytes / 1024,
    chunks: srcs.map((s) => s.split('/').pop()).sort(),
  }
}

const { types, routes } = await loadRoutes()
let warnings = 0

console.log('')
for (const type of types) {
  const route = representative(routes, type)
  const rows = []
  for (const m of route.candidateModes) rows.push(await measure(m, type, route.key))

  console.log(`${type}/${route.key}  (widgets ${route.interactiveCount}, ${route.payloadKB}KB)`)
  console.log(`  ${'모드'.padEnd(10)}${'HTML(KB)'.padStart(10)}${'JS(KB)'.padStart(10)}${'청크'.padStart(7)}`)
  for (const r of rows) {
    console.log(
      `  ${r.mode.padEnd(10)}${r.htmlKB.toFixed(1).padStart(10)}` +
        `${r.jsKB.toFixed(1).padStart(10)}${String(r.chunks.length).padStart(7)}`,
    )
  }

  const islands = rows.find((r) => r.mode === 'islands')
  const ssr = rows.find((r) => r.mode === 'ssr')
  if (islands && ssr) {
    const saved = ssr.jsKB - islands.jsKB
    console.log(
      `  Islands vs SSR: JS ${saved >= 0 ? '-' : '+'}${Math.abs(saved).toFixed(1)}KB ` +
        `(${((saved / ssr.jsKB) * 100).toFixed(1)}%)`,
    )
  }

  const serverRendered = rows.filter((r) => ['ssr', 'stream', 'ssg'].includes(r.mode))
  const ref = serverRendered[0]?.chunks.join(',')
  const mismatched = serverRendered.filter((r) => r.chunks.join(',') !== ref).map((r) => r.mode)
  if (mismatched.length > 0) {
    warnings++
    console.log(`  경고: 서버 렌더 모드 간 청크 집합 불일치 — ${mismatched.join(', ')}`)
  }
  console.log('')
}

if (warnings > 0) {
  console.log(`${warnings}개 유형에서 서버 렌더 모드의 번들이 갈렸다 — 모드 비교가 오염될 수 있다`)
}
