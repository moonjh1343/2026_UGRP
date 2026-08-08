/**
 * 라우트 정적 특징 룩업 테이블 산출 (설계 문서 §10).
 *
 * 결정 계층은 "모드별 라우트 JS 번들 크기"를 피처로 쓴다(제안서 §3.4). 이 값을
 * 요청마다 계산할 수는 없고, 단일 값으로 뭉뚱그릴 수도 없다 — 모드별 차이가
 * 곧 Islands의 이득이므로 뭉치면 그 신호가 사라진다.
 *
 * 빌드 매니페스트를 파싱하지 않고 **실제 전송량**을 잰다. Next 16(Turbopack)에는
 * app-build-manifest.json이 없고, 있더라도 매니페스트는 청크 목록이지 전송 바이트가
 * 아니다. 브라우저가 받는 것이 피처여야 하므로 HTML의 <script src>를 따라간다.
 *
 * 산출: policy/bundles.generated.json
 * 사용: npm run build && npm start &  →  npm run analyze:routes  → (필요 시) npm run build
 *
 * 마지막 재빌드가 필요한 이유: 이 JSON은 엣지 번들에 정적 임포트되므로 한 빌드
 * 뒤처진 값이 임베드된다. 코드가 그대로면 번들 크기도 그대로라 보통은 무시해도 되고,
 * 값을 확정하려면 한 번 더 빌드하면 된다.
 */
import { writeFile } from 'node:fs/promises'
import { BASE, loadRoutes, pageUrl, representative } from './_shared.mjs'

async function bundleKB(mode, type, key) {
  const res = await fetch(pageUrl(mode, type, key))
  if (!res.ok) throw new Error(`${mode}/${type}/${key}: HTTP ${res.status}`)
  const html = await res.text()
  const srcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]

  let bytes = 0
  for (const src of srcs) {
    bytes += (await (await fetch(new URL(src, BASE))).arrayBuffer()).byteLength
  }
  return bytes / 1024
}

const { types, routes, modes } = await loadRoutes()
const byModeType = {}

console.log('')
for (const type of types) {
  /*
   * 유형당 대표 인스턴스 하나로 잰다. 번들은 **컴포넌트 그래프**가 결정하고,
   * 인스턴스는 데이터 무게만 바꾸므로 같은 유형 안에서는 동일하다.
   */
  const route = representative(routes, type)
  const row = []
  for (const mode of route.candidateModes) {
    const kb = await bundleKB(mode, type, route.key)
    byModeType[`${mode}/${type}`] = Number(kb.toFixed(2))
    row.push(`${mode}=${kb.toFixed(1)}`)
  }
  // 후보에서 빠진 모드는 측정하지 않는다 — 그리드에 없는 셀이다
  console.log(`  ${type.padEnd(14)}${row.join('  ')}`)
}

const out = {
  note: 'npm run analyze:routes 산출물. 손으로 고치지 말 것.',
  generatedAt: new Date().toISOString(),
  source: BASE,
  unit: 'KB',
  byModeType,
}

const path = new URL('../policy/bundles.generated.json', import.meta.url)
await writeFile(path, JSON.stringify(out, null, 2) + '\n')

console.log(`\n  ${Object.keys(byModeType).length}개 (모드, 유형) 조합 기록 → policy/bundles.generated.json`)
console.log(`  모드 ${modes.length}종 중 유형별 M(r)만 측정 — 배제된 셀은 그리드에 없다`)
console.log('  이 값을 엣지 번들에 반영하려면 npm run build를 한 번 더 실행한다\n')
