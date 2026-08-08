/**
 * Factorial 수집 실행기.
 *
 * 배포에서는 Step Functions Distributed Map이 셀 그리드를 분배하고 DynamoDB가 체크포인트를
 * 든다. 여기서는 같은 구조를 단일 프로세스로 낸다 — **셀 단위 재개 가능성**이 핵심이고,
 * 그 성질은 분산 여부와 무관하다.
 *
 * 실행 구조가 이렇게 생긴 이유:
 *
 *   부하 수준별로 묶어서 → 부하를 한 번 걸고 → 그 안의 셀들을 무작위 순서로 돈다
 *
 * 부하 전환은 안정화에 수십 초가 걸린다. 셀마다 부하를 갈아끼우면 그 전이 구간이 측정에
 * 섞이고, 시간의 대부분을 부하 안정화에 쓰게 된다. 반면 **부하 그룹 안에서는 반드시
 * 무작위 순서**여야 한다(제안서 §5.2) — 순차로 돌면 실행 시간에 따른 드리프트(열 스로틀링,
 * 캐시 워밍, GC 리듬)가 특정 모드에 체계적으로 몰려 그 모드의 성능처럼 보인다.
 *
 * 사용:
 *   node run.mjs --name pilot --reps 30 --types content,dashboard --loads idle
 *   node run.mjs --name pilot                # 같은 이름으로 재실행 = 재개
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startLoad, loadProfile } from '../load/generator.mjs'
import { Checkpoint } from './lib/checkpoint.mjs'
import { captureEnv } from './lib/env.mjs'
import { cellId, expandGrid, loadCalibration, loadRouteTable, makeRng, shuffle } from './lib/grid.mjs'
import { measureOnce } from './lib/measure.mjs'
import { median, removeOutliers } from './lib/stats.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
function list(name) {
  const v = arg(name, null)
  return v ? v.split(',').map((s) => s.trim()) : null
}
const flag = (name) => process.argv.includes(`--${name}`)

const NAME = arg('name', 'run')
const REPS = Number(arg('reps', 30))
/** 워밍업 3회 (제안서 §5.2) — JIT·커넥션 풀·라우트 캐시가 안정된 뒤부터 잰다. */
const WARMUP = Number(arg('warmup', 3))
const ORDER_SEED = arg('seed', 'ugrp-2026')
const ALLOW_STALE = !flag('skip-stale')
// fileURLToPath — Windows에서 URL.pathname은 `/C:/…` 형태라 그대로 쓰면 경로가 깨진다
const RUN_DIR = fileURLToPath(new URL(`./runs/${NAME}`, import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ 그리드

const table = await loadRouteTable(BASE)
const calibration = await loadCalibration()
const profile = await loadProfile()

const filter = {
  devices: list('devices'),
  networks: list('networks'),
  loads: list('loads'),
  types: list('types'),
  routeKeys: list('routes'),
  modes: list('modes'),
  cacheStates: list('cache'),
}

const cells = expandGrid({ routes: table.routes, filter })
if (cells.length === 0) {
  console.error('그리드가 비었다 — 필터를 확인하라')
  process.exit(1)
}

const browser = await chromium.launch()
const env = await captureEnv({ base: BASE, browser, seeds: { order: ORDER_SEED } })

const ckpt = new Checkpoint(RUN_DIR)
const opened = await ckpt.open({
  name: NAME,
  createdAt: new Date().toISOString(),
  reps: REPS,
  warmup: WARMUP,
  seeds: { order: ORDER_SEED },
  filter,
  /*
   * 두 수를 모두 기록한다(제안서 §5.2 각주).
   *   sumCandidateModes — 행동 공간의 크기 Σ_r |M(r)|
   *   cellCount         — 캐시 축까지 반영한 실제 측정 셀 수
   * 서로 다른 질문에 답하므로 하나만 남기면 나중에 복원할 수 없다.
   */
  sumCandidateModes: table.totalCandidateCells,
  cellCount: cells.length,
  fullGridCellCount: expandGrid({ routes: table.routes }).length,
  calibration: calibration?.levels ?? null,
  env,
})

console.log(`\n실험 '${NAME}' — 셀 ${cells.length}개 × 반복 ${REPS}회`)
console.log(`  브라우저 ${env.browser.version} · Node ${env.node} · Next ${env.next}`)
console.log(`  순서 시드 ${ORDER_SEED}`)

/*
 * 예상 소요를 미리 알린다. stale 축은 반복마다 재검증 창(60초)을 통째로 기다리므로
 * 셀 수가 아니라 **대기 시간**이 실행 시간을 지배한다. 시작한 뒤에 알게 되면 늦다.
 */
const staleCells = cells.filter((c) => c.cache === 'stale').length
const otherCells = cells.length - staleCells
const staleHours = (staleCells * REPS * 62) / 3600
const otherHours = (otherCells * REPS * 5) / 3600
console.log(
  `  예상 ${(staleHours + otherHours).toFixed(1)}시간` +
    `${staleCells ? ` (stale ${staleCells}셀이 ${staleHours.toFixed(1)}시간)` : ''} — 단일 프로세스 직렬 기준`,
)
if (staleCells > 0 && !ALLOW_STALE) {
  console.log('  주의: --skip-stale이 켜져 있다. 검증용 탈출구이지 수집 옵션이 아니다 —')
  console.log('        stale 셀을 빼면 §3.1.2의 missRate를 관측할 수 없다.')
}
if (opened.resumed) {
  console.log(`  재개 — 완료 ${opened.doneCount}셀`)
  if (opened.drift.length) {
    console.error(`\n  중단: 이전 실행과 환경이 다르다 (${opened.drift.join(', ')}).`)
    console.error('  앞뒤 데이터를 같은 데이터셋으로 볼 수 없다. 새 --name으로 시작하라.')
    await browser.close()
    process.exit(1)
  }
}
if (!calibration) {
  console.log('  주의: load/calibration.generated.json 없음 — 부하 셀은 VU를 알 수 없어 건너뛴다')
}

// -------------------------------------------------- 부하 수준으로 묶어 실행

const byLoad = new Map()
for (const c of cells) {
  if (!byLoad.has(c.load)) byLoad.set(c.load, [])
  byLoad.get(c.load).push(c)
}

const rng = makeRng(ORDER_SEED)
let measured = 0
let skipped = 0
let failedReps = 0
const startedAt = Date.now()

for (const [level, group] of byLoad) {
  const vus = level === 'idle' ? 0 : (calibration?.levels?.[level]?.vus ?? null)
  if (vus === null) {
    console.log(`\n[부하 ${level}] 캘리브레이션 없음 — ${group.length}셀 건너뜀`)
    skipped += group.length
    continue
  }

  /*
   * 부하는 그룹 시작에 한 번 걸고 그룹 내내 **얼린다.**
   * 측정 중에 VU를 조정하면 부하가 측정 요청에 반응하게 되어 외생성이 깨진다.
   */
  const load = await startLoad({ vus, profile })
  if (vus > 0) {
    console.log(`\n[부하 ${level}] VU ${vus} — 안정화 대기`)
    await sleep(10_000)
  } else {
    console.log(`\n[부하 ${level}] 배경 부하 없음`)
  }

  try {
    // 그룹 안에서 무작위 순서 — 인프라 드리프트가 특정 모드에 몰리지 않게 한다
    const ordered = shuffle(group, rng)

    for (const cell of ordered) {
      const id = cellId(cell)
      if (ckpt.has(id)) continue

      const samples = { LCP: [], INP: [], TBT: [], TTFB: [] }
      const rows = []
      let cellFailed = 0

      for (let rep = -WARMUP; rep < REPS; rep++) {
        const r = await measureOnce({ base: BASE, browser, cell, rep, allowStale: ALLOW_STALE })

        if (!r.ok) {
          if (r.reason === 'stale-skipped') {
            cellFailed = REPS
            break
          }
          cellFailed++
          failedReps++
          continue
        }
        if (rep < 0) continue // 워밍업은 기록하지 않는다

        const row = {
          cellId: id,
          ...cell,
          rep,
          load: cell.load,
          vus,
          ts: Date.now(),
          ...r.metrics,
          cacheStatus: r.cacheStatus,
          serverRenderCpuUs: r.serverRenderCpuUs,
          serverRenderWallMs: r.serverRenderWallMs,
          serverRenderCount: r.serverRenderCount,
          hydrationErrors: r.hydrationErrors,
          interactionsPerformed: r.interaction.performed,
          interactionsFailed: r.interaction.failures.length,
          cid: r.cid,
        }
        rows.push(row)
        await ckpt.record(row)
        for (const k of Object.keys(samples)) {
          if (Number.isFinite(r.metrics[k])) samples[k].push(r.metrics[k])
        }
      }

      if (rows.length === 0) {
        skipped++
        await ckpt.complete(id, { reps: 0, failed: cellFailed, status: 'skipped' })
        continue
      }

      // 이상치 제거는 요약에만 적용한다 — 원본 행은 results.jsonl에 그대로 남는다
      const summary = {}
      for (const [k, xs] of Object.entries(samples)) {
        const { kept, removed } = removeOutliers(xs)
        summary[k] = { median: median(kept), n: kept.length, outliers: removed.length }
      }

      measured++
      await ckpt.complete(id, { reps: rows.length, failed: cellFailed, summary, status: 'ok' })

      const el = ((Date.now() - startedAt) / 60000).toFixed(1)
      console.log(
        `  ${String(measured).padStart(4)}/${cells.length}  ${id.padEnd(52)} ` +
          `LCP=${Math.round(summary.LCP.median)}ms n=${summary.LCP.n}` +
          `${cellFailed ? ` 실패=${cellFailed}` : ''}  [${el}분]`,
      )
    }
  } finally {
    const stats = await load.stop()
    if (vus > 0) {
      console.log(`[부하 ${level}] 종료 — 배경 요청 ${stats.requests}건, 오류 ${stats.errors}건`)
      await sleep(5000)
    }
  }
}

await browser.close()

console.log(`\n완료 — 측정 ${measured}셀, 건너뜀 ${skipped}셀, 실패 반복 ${failedReps}회`)
console.log(`  ${RUN_DIR}`)
if (failedReps > 0) {
  console.log('  실패한 반복은 조인이 성립하지 않은 것이다 — 피처 없는 라벨이라 버렸다.')
}
