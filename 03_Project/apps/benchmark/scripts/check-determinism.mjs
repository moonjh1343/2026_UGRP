/**
 * 결정성 검증: 같은 라우트를 N회 요청했을 때 페이로드가 **바이트 단위로 동일한가**.
 *
 * 셀당 30회 반복의 분산이 곧 측정 노이즈이므로, 페이로드가 흔들리면
 * 모드 간 차이 신호가 그 노이즈에 묻힌다(설계 문서 §6).
 *
 * 사용: npm start &  →  npm run check:determinism
 */
import { createHash } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const REPEATS = Number(process.env.REPEATS ?? 10)
const ROUTES = process.env.ROUTES?.split(',') ?? [
  'content-01',
  'content-02',
  'content-03',
  'content-04',
  'content-05',
]

let failed = 0

for (const slug of ROUTES) {
  const hashes = new Set()
  let bytes = 0

  for (let i = 0; i < REPEATS; i++) {
    const res = await fetch(`${BASE}/api/data/content/${slug}`)
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    bytes = body.byteLength
    hashes.add(createHash('sha256').update(body).digest('hex'))
  }

  const kb = (bytes / 1024).toFixed(1)
  if (hashes.size === 1) {
    console.log(`  OK    ${slug}  ${REPEATS}회 동일  (${kb}KB)`)
  } else {
    failed++
    console.log(`  FAIL  ${slug}  서로 다른 해시 ${hashes.size}종  (${kb}KB)`)
  }
}

if (failed > 0) {
  console.error(`\n${failed}건 비결정적 — Math.random()/Date.now() 사용을 확인하라`)
  process.exit(1)
}
console.log(`\n전 라우트 결정적 — ${REPEATS}회 반복 바이트 동일`)
