/**
 * 오염 구간 격리와 재수집 등록.
 *
 * 측정 중에 같은 머신에서 CPU를 쓰면(학습, 빌드, 타입체크) 그 시간대의 행은
 * 부하 축이 외생이라는 전제를 만족하지 않는다. idle 셀이면 특히 그렇다 —
 * "배경 부하 없음"이 사실이 아니게 된다. 그런 구간을 지우는 대신 **시간 창으로
 * 표시**한다.
 *
 * 왜 행을 지우지 않는가:
 *   - results.jsonl은 append-only다. 수집이 도는 중에 다시 쓰면 러너의 append와
 *     경합해 그 순간의 행이 사라질 수 있다.
 *   - 지워버리면 "이 구간에 무슨 일이 있었나"라는 기록 자체가 없어진다. 재현
 *     가능성 요구사항(환경·시드를 전부 기록한다)과 같은 이유로 남긴다.
 *   - 셀 id로 격리하면 재수집한 행까지 같이 버려진다. 시간 창이면 재수집분은
 *     ts가 더 나중이라 자연히 살아남는다.
 *
 * 사용:
 *   node quarantine.mjs --name <실험> --from <ISO> --to <ISO> --reason "..."
 *   node quarantine.mjs --name <실험>                    # 현재 격리 상태 확인
 *   node quarantine.mjs --name <실험> --requeue          # done.jsonl에서 빼 재수집 대상으로
 *
 * --requeue는 수집이 멈춘 뒤에 돌린다. done.jsonl은 러너가 **메모리에 올린 뒤**
 * append로만 쓰므로, 도는 중에 지워도 이번 실행에는 반영되지 않고 파일만 어긋난다.
 */
import { readFile, rename, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const name = arg('name')
if (!name) {
  console.error('--name <실험> 이 필요하다')
  process.exit(1)
}

const dir = join(HERE, 'runs', name)
const resultsPath = join(dir, 'results.jsonl')
const donePath = join(dir, 'done.jsonl')
const quarantinePath = join(dir, 'quarantine.json')

const readJsonl = async (p) => {
  let raw
  try {
    raw = await readFile(p, 'utf8')
  } catch (err) {
    // 셀이 0개 완료된 실행에는 results/done이 아직 없다 — 빈 목록이 맞지, 크래시가 아니다.
    if (err.code === 'ENOENT') return []
    throw err
  }
  const lines = raw.split('\n').filter((l) => l.trim())
  const out = []
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch {
      if (i !== lines.length - 1) throw new Error(`${p}의 ${i + 1}번째 줄이 깨졌다`)
      // 마지막 줄은 러너가 쓰는 중일 수 있다
    }
  }
  return out
}

const loadQuarantine = async () => {
  try {
    return JSON.parse(await readFile(quarantinePath, 'utf8'))
  } catch {
    return { experiment: name, windows: [] }
  }
}

/** 수집이 아직 도는 중인가. append 경합을 피하려면 알아야 한다. */
const looksLive = async () => {
  try {
    const s = await stat(resultsPath)
    return Date.now() - s.mtimeMs < 120_000
  } catch {
    return false
  }
}

/** 창에 걸리는 셀과 행 수. */
const affected = (rows, windows) => {
  const hit = new Map()
  for (const r of rows) {
    for (const w of windows) {
      if (r.ts >= w.fromTs && r.ts <= w.toTs) {
        hit.set(r.cellId, (hit.get(r.cellId) ?? 0) + 1)
        break
      }
    }
  }
  return hit
}

const rows = await readJsonl(resultsPath)
const q = await loadQuarantine()

// ── 창 추가 ────────────────────────────────────────────────────────────────
const from = arg('from')
const to = arg('to')
if (from || to) {
  if (!from || !to) {
    console.error('--from 과 --to 는 함께 준다')
    process.exit(1)
  }
  const fromTs = Date.parse(from)
  const toTs = Date.parse(to)
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
    console.error(`창이 유효하지 않다: ${from} ~ ${to}`)
    process.exit(1)
  }
  const reason = arg('reason')
  if (typeof reason !== 'string') {
    console.error('--reason "..." 이 필요하다 — 왜 오염됐는지가 이 파일의 핵심 내용이다')
    process.exit(1)
  }
  const w = {
    fromTs,
    toTs,
    from: new Date(fromTs).toISOString(),
    to: new Date(toTs).toISOString(),
    reason,
    recordedAt: new Date().toISOString(),
  }
  const hit = affected(rows, [w])
  w.cells = [...hit.keys()].sort()
  w.rowCount = [...hit.values()].reduce((a, b) => a + b, 0)
  q.windows.push(w)
  await writeFile(quarantinePath, JSON.stringify(q, null, 2) + '\n')
  console.log(`창 추가 → ${quarantinePath}`)
  console.log(`  ${w.from} ~ ${w.to}`)
  console.log(`  ${w.reason}`)
  console.log(`  영향 셀 ${w.cells.length}개 · 행 ${w.rowCount}개`)
}

// ── 현재 상태 ──────────────────────────────────────────────────────────────
const hit = affected(rows, q.windows)
const done = new Set((await readJsonl(donePath)).map((d) => d.cellId))

/*
 * 재수집 기준은 "격리된 행이 있는가"가 아니라 "**남은 반복이 쓸 만한가**"다.
 * 30반복 중 1회만 창에 걸린 셀을 통째로 다시 재는 것은, 오염을 남겨두는 것만큼이나
 * 데이터를 낭비한다. 실패로 이미 25~30회 사이에서 흔들리는 셀들과 같은 잣대를 쓴다.
 */
const MIN_REPS = Number(arg('min-reps', 20))
const survivors = new Map()
for (const [c] of hit) survivors.set(c, 0)
for (const r of rows) {
  if (!survivors.has(r.cellId)) continue
  const inWindow = q.windows.some((w) => r.ts >= w.fromTs && r.ts <= w.toTs)
  if (!inWindow) survivors.set(r.cellId, survivors.get(r.cellId) + 1)
}
const requeueable = [...hit.keys()].filter((c) => done.has(c) && survivors.get(c) < MIN_REPS)

console.log(`\n실험 ${name} — 전체 ${rows.length}행 · 격리 창 ${q.windows.length}개`)
console.log(`  격리 행 ${[...hit.values()].reduce((a, b) => a + b, 0)}개 · 영향 셀 ${hit.size}개`)
console.log(`  재수집 기준: 생존 반복 < ${MIN_REPS}회`)
for (const [c, n] of [...hit].sort()) {
  const left = survivors.get(c)
  const mark = !done.has(c) ? '[미완료]' : left < MIN_REPS ? '[재수집]' : '[유지]  '
  console.log(`    ${mark} ${c} — 격리 ${n}행, 생존 ${left}회`)
}

// ── 재수집 등록 ────────────────────────────────────────────────────────────
if (arg('requeue')) {
  if (await looksLive()) {
    console.error(
      '\n수집이 도는 중으로 보인다(results.jsonl이 2분 내 갱신됨).\n' +
        '  done.jsonl은 러너가 시작할 때 메모리로 읽고 그 뒤로는 append만 한다 —\n' +
        '  지금 지워도 이번 실행에는 반영되지 않고, 러너가 나중에 다시 append하면\n' +
        '  지운 항목이 되살아난다. 수집이 끝난 뒤에 돌릴 것.',
    )
    process.exit(1)
  }
  if (requeueable.length === 0) {
    console.log(`\n재수집할 셀 없음 — 격리된 셀이 모두 생존 반복 ${MIN_REPS}회 이상을 남겼다.`)
    process.exit(0)
  }
  const requeueSet = new Set(requeueable)
  const kept = (await readJsonl(donePath)).filter((d) => !requeueSet.has(d.cellId))
  /*
   * done.jsonl 재작성은 원자적이어야 한다. writeFile 도중 죽으면 파일이 잘려
   * 다음 실행이 완료 셀을 대량 재측정한다. 임시 파일에 쓰고 rename — 같은
   * 파일시스템 안의 rename은 원자적이다.
   */
  const tmpPath = `${donePath}.tmp`
  await writeFile(tmpPath, kept.map((d) => JSON.stringify(d)).join('\n') + '\n')
  await rename(tmpPath, donePath)
  console.log(`\ndone.jsonl에서 ${requeueable.length}개 셀 제거 — ${kept.length}개 남음`)
  for (const c of requeueable) console.log(`    ${c}`)
  console.log(`\n다음 실행이 이 셀들을 다시 잰다:  node run.mjs --name ${name} ...`)
  console.log('  이전 행은 results.jsonl에 그대로 있고 격리 창이 분석에서 걸러낸다.')
}
