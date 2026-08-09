/**
 * 증류 트리 배포 계약 검사 (7단계 산출물 → policy/model/).
 *
 * `check:policy`는 **이미 배포된** 트리의 런타임 동작(경계·오버헤드·SEO 고정)을
 * 서버를 통해 잰다. 여기서 보는 것은 그 앞 단계다 — training/out/tree.json이
 * surrogate.ts가 읽을 수 있는 모양인가, 그리고 피처 이름이 서빙 피처 벡터와
 * 맞는가. 서버를 전혀 건드리지 않으므로 수집이 도는 중에도 돌릴 수 있다.
 *
 * 이 검사가 필요한 이유는 실패가 조용하기 때문이다. surrogate.ts의 evalTree는
 *
 *     const v = x[cur.feature]
 *     cur = (v ?? 0) <= cur.threshold ? cur.left : cur.right
 *
 * 이라, 트리에 `rtt_ms`처럼 toVector()에 없는 이름이 들어 있으면 예외가 나지
 * 않는다. 매 요청 0으로 읽혀 항상 왼쪽 가지로만 가고, 모델은 "돌지만 틀린" 상태가
 * 된다. 파이썬 쪽 FEATURE_ORDER와 features.ts는 수동 동기화라 어긋날 수 있다
 * (training/README.md 참조) — 그 어긋남을 여기서 잡는다.
 *
 * 사용: node scripts/check-distilled-tree.mjs [트리 경로]
 *       기본 경로는 03_Project/training/out/tree.json
 */
import { readFileSync } from 'node:fs'

const TREE_PATH =
  process.argv[2] ?? new URL('../../../training/out/tree.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')

let failures = 0
const ok = (m) => console.log(`  ok   ${m}`)
const fail = (m) => {
  console.error(`  FAIL ${m}`)
  failures++
}

// ── 서빙 피처 벡터의 키 집합. features.ts에서 뽑는다 ────────────────────────
// 목록을 여기에 복사해 두면 그 복사본이 또 하나의 어긋날 수 있는 사본이 된다.
// toVector()가 반환하는 객체 리터럴의 키를 원본에서 직접 읽는다.
function servingFeatureKeys() {
  const src = readFileSync(new URL('../policy/features.ts', import.meta.url), 'utf8')
  const start = src.indexOf('export function toVector')
  if (start < 0) throw new Error('features.ts에서 toVector를 찾지 못했다 — 이 검사가 낡았다')
  const body = src.slice(src.indexOf('return {', start), src.indexOf('\n}', start))
  const keys = [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
  if (keys.length < 10) throw new Error(`toVector 키 추출 실패(${keys.length}개) — 정규식이 낡았다`)
  return new Set(keys)
}

// ── 트리 구조 검사 ──────────────────────────────────────────────────────────
function walk(node, depth, path, acc) {
  if (node == null || typeof node !== 'object') {
    acc.structural.push(`${path}: 노드가 객체가 아니다`)
    return
  }
  if ('leaf' in node) {
    if (!Number.isFinite(node.leaf)) acc.structural.push(`${path}: leaf가 유한한 수가 아니다 (${node.leaf})`)
    acc.maxDepth = Math.max(acc.maxDepth, depth)
    acc.leaves++
    return
  }
  for (const k of ['feature', 'threshold', 'left', 'right']) {
    if (!(k in node)) acc.structural.push(`${path}: 분기 노드에 ${k}가 없다`)
  }
  if (typeof node.feature !== 'string') acc.structural.push(`${path}: feature가 문자열이 아니다`)
  else acc.features.add(node.feature)
  if (!Number.isFinite(node.threshold)) acc.structural.push(`${path}: threshold가 유한한 수가 아니다`)
  walk(node.left, depth + 1, `${path}.left`, acc)
  walk(node.right, depth + 1, `${path}.right`, acc)
}

const tree = JSON.parse(readFileSync(TREE_PATH, 'utf8'))
const reference = JSON.parse(readFileSync(new URL('../policy/model/tree.v0.json', import.meta.url), 'utf8'))

console.log(`증류 트리 검사: ${TREE_PATH}`)
console.log(`  version=${tree.version}`)

// A. surrogate.ts가 실제로 읽는 필드가 있는가.
console.log('\nA. surrogate.ts가 읽는 필드')
for (const k of ['root', 'modeIndex', 'version']) {
  if (tree[k] === undefined) fail(`${k} 없음 — surrogate.ts가 이 필드를 정적으로 읽는다`)
}
if (failures === 0) ok('root · modeIndex · version 존재')

// B. 최상위 스키마가 기준 트리와 같은가. 여분 필드는 무해하지만 누락은 기록 손실이다.
console.log('\nB. 최상위 스키마 (tree.v0.json 기준)')
const missing = Object.keys(reference).filter((k) => !(k in tree))
const extra = Object.keys(tree).filter((k) => !(k in reference))
if (missing.length) fail(`누락 필드: ${missing.join(', ')}`)
else ok(`기준 트리의 ${Object.keys(reference).length}개 필드 모두 존재`)
if (extra.length) console.log(`  참고 추가 필드: ${extra.join(', ')}`)

// C. 노드 구조와 깊이.
console.log('\nC. 노드 구조 · 깊이')
const acc = { structural: [], features: new Set(), maxDepth: 0, leaves: 0 }
walk(tree.root, 1, 'root', acc)
if (acc.structural.length) {
  for (const m of acc.structural.slice(0, 10)) fail(m)
  if (acc.structural.length > 10) fail(`... 외 ${acc.structural.length - 10}건`)
} else {
  ok(`잎 ${acc.leaves}개 · 최대 깊이 ${acc.maxDepth}`)
}
// 깊이는 **분기 레벨 수**로 센다 — 예측 1회당 비교 횟수이고, 엣지 추론 예산의
// 근거가 되는 양이다. walk()는 루트를 1로 세므로 노드 레벨이고, 분기 레벨은 그보다 1 작다.
const splitLevels = Math.max(0, acc.maxDepth - 1)
const budget = tree.maxDepthBudget ?? reference.maxDepthBudget
if (tree.maxDepth !== undefined && tree.maxDepth !== splitLevels) {
  fail(`선언 maxDepth ${tree.maxDepth} ≠ 실제 분기 레벨 ${splitLevels} — 두 값이 다른 것을 세고 있다`)
} else {
  ok(`선언 maxDepth = 실제 분기 레벨 ${splitLevels}`)
}
if (splitLevels > budget) {
  fail(`분기 레벨 ${splitLevels} > 예산 ${budget} — 엣지 추론 예산의 근거가 무너진다`)
} else {
  ok(`분기 레벨 ${splitLevels} ≤ 예산 ${budget}`)
}

// D. 피처 이름이 서빙 벡터에 있는가. 이 검사가 이 스크립트의 존재 이유다.
console.log('\nD. 피처 이름 ↔ features.ts의 toVector()')
const serving = servingFeatureKeys()
const unknown = [...acc.features].filter((f) => !serving.has(f))
if (unknown.length) {
  fail(`toVector()에 없는 피처: ${unknown.join(', ')}`)
  fail('  → evalTree에서 undefined ?? 0으로 읽혀, 예외 없이 항상 왼쪽 가지로 간다.')
  fail('  → training/ugrp_train/config.py의 FEATURE_ORDER와 features.ts가 어긋났다.')
} else {
  ok(`사용 피처 ${acc.features.size}개 모두 toVector()에 존재: ${[...acc.features].sort().join(', ')}`)
}

// E. modeIndex 일치. 어긋나면 모드 점수가 통째로 뒤바뀐다.
console.log('\nE. modeIndex')
const refIdx = JSON.stringify(reference.modeIndex)
if (JSON.stringify(tree.modeIndex) !== refIdx) {
  fail(`modeIndex 불일치: ${JSON.stringify(tree.modeIndex)} vs 기준 ${refIdx}`)
} else {
  ok(`기준과 일치 ${refIdx}`)
}
// mode를 분기 피처로 쓰지 않는 트리는 모든 모드에 같은 점수를 주므로 argmin이 무의미하다.
if (!acc.features.has('mode')) {
  fail("분기에 'mode'가 없다 — 모든 후보 모드가 같은 점수를 받아 argmin이 첫 후보를 고른다")
} else {
  ok("'mode'로 분기한다 — 모드 간 점수 차가 생긴다")
}

// F. 학습되지 않은 트리를 실배포로 착각하지 않게.
console.log('\nF. 출처 표기')
if (tree.version === 'v0-unfitted') {
  fail("version이 'v0-unfitted'다 — surrogate.ts의 MODEL_IS_FITTED가 false가 된다")
} else if (tree.warning) {
  ok(`경고 문구 있음: ${String(tree.warning).slice(0, 60)}...`)
} else if (!tree.trainedOn) {
  fail('trainedOn도 warning도 없다 — 어떤 데이터로 학습했는지 기록이 없다')
} else {
  ok(`trainedOn 기록 있음 (${tree.trainedOn.nRows}행, ${(tree.trainedOn.experiments ?? []).join(',')})`)
}

console.log(
  failures === 0
    ? '\n통과 — 이 트리는 policy/model/tree.v0.json 자리에 넣을 수 있다.\n' +
        '  남은 것은 서버 검사다: 파일을 교체하고 npm run build && npm start 후 npm run check:policy.\n' +
        '  (수집이 도는 동안에는 재빌드·재시작이 파일럿을 죽이므로 하지 말 것.)'
    : `\n실패 ${failures}건 — 교체하면 안 된다.`,
)
process.exit(failures === 0 ? 0 : 1)
