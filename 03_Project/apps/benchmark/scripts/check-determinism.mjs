/**
 * 결정성 검증: 같은 라우트를 N회 요청했을 때 페이로드가 **바이트 단위로 동일한가**.
 *
 * 셀당 30회 반복의 분산이 곧 측정 노이즈이므로, 페이로드가 흔들리면
 * 모드 간 차이 신호가 그 노이즈에 묻힌다(설계 문서 §6).
 *
 * 사용: npm start &  →  npm run check:determinism
 */
import { createHash } from 'node:crypto'
import { BASE, loadRoutes } from './_shared.mjs'

const REPEATS = Number(process.env.REPEATS ?? 5)

const { routes } = await loadRoutes()
let failed = 0
const sizeByType = new Map()

for (const route of routes) {
  const hashes = new Set()
  let bytes = 0

  for (let i = 0; i < REPEATS; i++) {
    const res = await fetch(`${BASE}/api/data/${route.type}/${route.key}`)
    if (!res.ok) throw new Error(`${route.key}: HTTP ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    bytes = body.byteLength
    hashes.add(createHash('sha256').update(body).digest('hex'))
  }

  const kb = (bytes / 1024).toFixed(1).padStart(7)
  if (hashes.size === 1) {
    console.log(`  OK    ${route.key.padEnd(18)} ${REPEATS}회 동일  ${kb}KB`)
  } else {
    failed++
    console.log(`  FAIL  ${route.key.padEnd(18)} 서로 다른 해시 ${hashes.size}종  ${kb}KB`)
  }

  const list = sizeByType.get(route.type) ?? []
  list.push({ key: route.key, bytes, axis: route.nodeCount * 1e6 + route.interactiveCount })
  sizeByType.set(route.type, list)
}

/*
 * 인스턴스 포화 검사.
 *
 * 생성기의 클램프가 확산 범위 상단을 자르면 서로 다른 인스턴스가 같은 페이로드가 되어
 * 인스턴스 수만큼의 그리드 커버리지를 조용히 잃는다. 실제로 wordsPerUnit의 상한 400과
 * list의 itemCount 상한 400에서 각 유형의 4·5번 인스턴스가 붙어버렸다.
 *
 * 개인화형은 지배 축이 fetchDelayMs(지연)라 페이로드가 같은 것이 정상이므로 제외한다.
 */
const PAYLOAD_INVARIANT_TYPES = new Set(['personalized', 'dashboard'])
let saturated = 0

for (const [type, list] of sizeByType) {
  if (PAYLOAD_INVARIANT_TYPES.has(type)) continue
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    const diff = Math.abs(cur.bytes - prev.bytes) / Math.max(1, prev.bytes)
    if (diff < 0.02) {
      saturated++
      console.log(
        `  포화  ${prev.key} ↔ ${cur.key} — 페이로드 차이 ${(diff * 100).toFixed(1)}%. ` +
          `생성기 클램프가 확산 상단을 자르고 있다`,
      )
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed}건 비결정적 — Math.random()/Date.now() 사용을 확인하라`)
  process.exit(1)
}
if (saturated > 0) {
  console.error(`\n${saturated}쌍 포화 — 인스턴스가 중복되어 그리드 커버리지를 잃는다`)
  process.exit(1)
}
console.log(
  `\n전 ${routes.length}개 라우트 결정적 — ${REPEATS}회 반복 바이트 동일, 인스턴스 포화 없음`,
)
