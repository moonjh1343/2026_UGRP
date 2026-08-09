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
import { planShards } from './lib/shard.mjs'
import { calibrateRemote, makeLoadVerifier, resetRemoteLoad, startRemoteLoad } from './lib/loadControl.mjs'
import { measureOnce } from './lib/measure.mjs'
import { median, removeOutliers } from './lib/stats.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

/*
 * 있으면 부하 생성기가 별도 태스크로 떠 있다는 뜻이고, 캘리브레이션도 여기서 새로 잡는다.
 * 없으면 로컬 실행 — 부하를 프로세스 안에서 돌리고 저장된 캘리브레이션을 쓴다.
 */
const LOAD_CONTROL_URL = process.env.LOAD_CONTROL_URL ?? null
/** 원격에서 새로 잡은 캘리브레이션. 실험 메타데이터에 남긴다. */
const remoteCalibration = {}

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

let cells = expandGrid({ routes: table.routes, filter })
if (cells.length === 0) {
  console.error('그리드가 비었다 — 필터를 확인하라')
  process.exit(1)
}

/*
 * 샤드 모드. --shard-count가 있으면 전체 그리드를 샤드로 나누고 자기 몫만 잰다.
 *
 * 분할은 **필터를 적용하기 전의 전체 그리드**에 대해 한다. 필터가 걸린 부분집합을
 * 나누면 같은 --shard-index가 실행마다 다른 셀을 가리키게 되어, 어느 샤드가 어느
 * 셀을 쟀는지가 재현되지 않는다.
 */
const SHARD_COUNT = arg('shard-count', null)
const SHARD_INDEX = arg('shard-index', null)
if (SHARD_COUNT != null || SHARD_INDEX != null) {
  if (SHARD_COUNT == null || SHARD_INDEX == null) {
    console.error('--shard-count 와 --shard-index 는 함께 준다')
    process.exit(1)
  }
  const total = Number(SHARD_COUNT)
  const idx = Number(SHARD_INDEX)
  const plan = planShards({
    cells: expandGrid({ routes: table.routes }),
    totalShards: total,
    reps: REPS,
    seed: ORDER_SEED,
  })
  if (!Number.isInteger(idx) || idx < 0 || idx >= plan.length) {
    console.error(`--shard-index ${SHARD_INDEX} 가 범위 밖이다 (0 ~ ${plan.length - 1})`)
    process.exit(1)
  }
  const mine = plan[idx]
  /*
   * 샤드는 부하 수준 하나만 맡는다. --loads를 함께 주면 어느 쪽이 이기는지가
   * 모호해지므로 막는다 — 조용히 한쪽을 무시하면 그 실행은 계획과 다른 것을 잰다.
   */
  if (filter.loads) {
    console.error('--shard-index 와 --loads 는 함께 쓸 수 없다 — 샤드가 이미 부하 수준을 정한다')
    process.exit(1)
  }
  const keep = new Set(mine.cells.map(cellId))
  cells = cells.filter((c) => keep.has(cellId(c)))
  console.log(
    `\n샤드 ${idx}/${plan.length} — 부하 ${mine.load} · 셀 ${mine.cellCount}개 · ` +
      `예상 ${(mine.costSeconds / 3600).toFixed(1)}시간`,
  )
  filter.shard = { index: idx, count: total, load: mine.load }
}

const browser = await chromium.launch()
const env = await captureEnv({ base: BASE, browser, seeds: { order: ORDER_SEED } })

/*
 * 체크포인트를 어디에 두는가.
 *
 *   클라우드 — Fargate 태스크에는 남는 디스크가 없다. 컨테이너가 죽으면 로컬 파일도
 *     함께 사라지고, 41시간짜리 실행에서 그건 데이터 손실이다.
 *   로컬 — JSONL 두 벌. 인터페이스가 같아서 아래 코드는 어느 쪽인지 모른다.
 */
const RESULTS_BUCKET = process.env.UGRP_RESULTS_BUCKET ?? null
const CHECKPOINT_TABLE = process.env.UGRP_CHECKPOINT_TABLE ?? null
const useCloud = Boolean(RESULTS_BUCKET && CHECKPOINT_TABLE)
if ((RESULTS_BUCKET || CHECKPOINT_TABLE) && !useCloud) {
  console.error(
    'UGRP_RESULTS_BUCKET과 UGRP_CHECKPOINT_TABLE은 함께 준다 — 하나만 있으면\n' +
      '  결과와 완료 표시가 다른 곳에 남아 재개가 성립하지 않는다.',
  )
  process.exit(1)
}

const ckpt = useCloud
  ? new (await import('./lib/cloudCheckpoint.mjs')).CloudCheckpoint({
      bucket: RESULTS_BUCKET,
      table: CHECKPOINT_TABLE,
      experiment: NAME,
      shardIndex: Number(process.env.UGRP_SHARD_INDEX ?? 0),
      region: process.env.AWS_REGION,
    })
  : new Checkpoint(RUN_DIR)
if (useCloud) {
  console.log(`\n체크포인트 — S3 ${RESULTS_BUCKET} · DynamoDB ${CHECKPOINT_TABLE}`)
}
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
  /*
   * **저장된 캘리브레이션은 원격 부하 모드에서 이 실행을 설명하지 않는다.**
   *
   * VU→CPU 관계는 태스크 크기에 종속이다. `calibration.generated.json`은 18코어 중
   * 1코어를 할당한 개발 머신 기준(low 6 / mid 30 / high 71)인데, 그 값이 Fargate
   * 2 vCPU 실행의 experiment.json에 그대로 실리면 S3의 실험 기록만 읽는 사람은
   * "부하 65% = VU 30"이라는 **틀린 값**을 보게 된다. 1샤드 검증에서 실제로 그렇게
   * 기록됐다(2026-08-09).
   *
   * 원격 모드에서 실제로 쓰인 값은 실행 시점 이진 탐색의 결과이고, 그것은
   * `recordCalibration()`이 따로 남긴다(로컬은 calibration.observed.json,
   * 클라우드는 DynamoDB의 `#calibration#<shard>`). 여기서는 null로 두어
   * **모른다는 사실**을 남긴다 — 다른 기계의 숫자를 남기는 것보다 정직하다.
   *
   * 모양은 바꾸지 않는다. training의 `features.py`가 `{수준: {cpuPct,
   * eventLoopP95Ms}}`를 그대로 순회하므로, null이면 그쪽 기본값(0)으로 떨어진다.
   */
  calibration: LOAD_CONTROL_URL ? null : (calibration?.levels ?? null),
  calibrationSource: LOAD_CONTROL_URL
    ? { mode: 'remote-search', recordedAt: `#calibration#${process.env.UGRP_SHARD_INDEX ?? 0}` }
    : { mode: 'stored-local', file: 'load/calibration.generated.json' },
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
let consecutiveFailures = 0
/** 연속 실패 상한 — 브라우저·서버가 죽은 채로 조용히 헛돌지 않게 막는다. */
const FAILURE_STREAK_LIMIT = Number(arg('failure-streak-limit', 15))
const startedAt = Date.now()

for (const [level, group] of byLoad) {
  const target = level === 'idle' ? 0 : (profile.targets?.[level] ?? null)

  /*
   * VU 수를 어디서 얻는가.
   *
   *   원격(LOAD_CONTROL_URL 있음) — 여기서 이진 탐색으로 새로 잡는다. 저장된
   *     calibration.generated.json은 18코어 중 1코어 할당 기준이라 Fargate 태스크
   *     크기에서는 다른 값이 나온다. 그대로 쓰면 부하 수준이 그리드가 말하는 것과
   *     다른 값이 되고, 그 사실이 데이터 어디에도 남지 않는다.
   *   로컬 — 저장된 캘리브레이션을 그대로 쓴다. 같은 머신에서 잰 값이다.
   */
  let vus
  let expectedCpuPct = null
  if (LOAD_CONTROL_URL) {
    if (target === null) {
      console.log(`\n[부하 ${level}] profile.targets에 목표 CPU가 없다 — ${group.length}셀 건너뜀`)
      skipped += group.length
      continue
    }
    console.log(`\n[부하 ${level}] 원격 캘리브레이션 — 목표 CPU ${target}%`)
    /*
     * **캘리브레이션은 실패할 수 있고, 실패가 곧 사람을 부를 일은 아니다.**
     *
     * 부하 태스크는 워커보다 오래 산다(desiredCount 고정). 앞선 워커가 죽었으면 부하는
     * 그 워커가 마지막에 지시한 VU로 계속 돌고 있고, 그 상태에서 첫 탐침이 들어가면
     * `setVus`가 수십 개 스트림을 정리하는 동안 제어 서버의 이벤트 루프가 굶어
     * 응답이 늦는다. slice-b2의 3·4번째 시도가 정확히 이것으로 죽었다(2026-08-09).
     *
     * 그래서 (a) 시작 전에 부하를 0으로 되돌려 놓고, (b) 실패하면 잠깐 쉬고 다시 한다.
     * 여기서 포기하면 샤드가 통째로 빠지고 — Parallel이 실행 전체를 실패시킨다.
     */
    let cal
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await resetRemoteLoad(LOAD_CONTROL_URL)
        cal = await calibrateRemote({ base: BASE, controlUrl: LOAD_CONTROL_URL, target })
        break
      } catch (err) {
        console.log(`  캘리브레이션 ${attempt}/3 실패: ${err.message}`)
        if (attempt === 3) throw err
        await new Promise((r) => setTimeout(r, 30_000))
      }
    }
    vus = cal.vus
    expectedCpuPct = cal.cpuPct
    remoteCalibration[level] = { ...cal, at: new Date().toISOString() }
    if (!cal.reached && target > 0) {
      console.log(`  경고: 목표 ${target}%에 도달하지 못했다 (VU ${cal.vus}, ${cal.cpuPct.toFixed(1)}%)`)
    }
    /*
     * 실험 메타데이터(experiment.json)는 재개 시 덮어쓰지 않는 것이 규칙이라 여기에
     * 못 넣는다. 그렇다고 기록을 빠뜨리면 "이 실행의 부하 수준이 실제로 VU 몇이었나"가
     * 사라진다 — 셀 정의의 일부이므로 별도 파일로 남긴다.
     */
    await ckpt.recordCalibration({ base: BASE, controlUrl: LOAD_CONTROL_URL, levels: remoteCalibration })
  } else {
    vus = level === 'idle' ? 0 : (calibration?.levels?.[level]?.vus ?? null)
    expectedCpuPct = level === 'idle' ? null : (calibration?.levels?.[level]?.cpuPct ?? null)
    if (vus === null) {
      console.log(`\n[부하 ${level}] 캘리브레이션 없음 — ${group.length}셀 건너뜀`)
      skipped += group.length
      continue
    }
  }

  /*
   * 부하는 그룹 시작에 한 번 걸고 그룹 내내 **얼린다.**
   * 측정 중에 VU를 조정하면 부하가 측정 요청에 반응하게 되어 외생성이 깨진다.
   */
  const load = LOAD_CONTROL_URL
    ? await startRemoteLoad({ controlUrl: LOAD_CONTROL_URL, vus })
    : await startLoad({ vus, profile })
  if (vus > 0) {
    console.log(`\n[부하 ${level}] VU ${vus} — 안정화 대기`)
    await sleep(10_000)
  } else {
    console.log(`\n[부하 ${level}] 배경 부하 없음`)
  }

  /*
   * 부하가 실제로 유지되는지 셀마다 확인한다. 행에 적히는 vus는 설정값이라,
   * 부하 생성기가 죽어도 "VU 30에서 잰 값"으로 남는다 — 사후에 구분할 방법이 없다.
   * 관측만 하고 보정하지 않는다(보정하면 외생성이 깨진다).
   */
  const verifier = makeLoadVerifier({ base: BASE, expectedCpuPct })

  try {
    // 그룹 안에서 무작위 순서 — 인프라 드리프트가 특정 모드에 몰리지 않게 한다
    const ordered = shuffle(group, rng)

    for (const cell of ordered) {
      const id = cellId(cell)
      if (ckpt.has(id)) continue

      const guard = await verifier.check()
      if (!guard.ok) {
        console.error(`\n${guard.reason}`)
        await load.stop().catch(() => {})
        await browser.close().catch(() => {})
        process.exit(1)
      }

      const samples = { LCP: [], INP: [], TBT: [], TTFB: [] }
      const rows = []
      let cellFailed = 0

      for (let rep = -WARMUP; rep < REPS; rep++) {
        /*
         * measureOnce()는 정상적인 실패(HTTP 오류, cid 없음)만 { ok:false }로 돌려주고,
         * Playwright의 예외(페이지 타임아웃 등)는 그대로 던진다. 여기서 잡지 않으면
         * 25시간짜리 실행이 반복 하나의 일시적 타임아웃으로 통째로 죽는다 —
         * 실제로 3번째 셀에서 이렇게 죽었다. 체크포인트가 셀 단위라 재개해도
         * 죽은 시점의 셀은 처음부터 다시 돈다는 것을 감안해도, 예외로 프로세스가
         * 죽는 것 자체는 반드시 막아야 한다.
         */
        let r
        try {
          r = await measureOnce({ base: BASE, browser, cell, rep, allowStale: ALLOW_STALE })
        } catch (err) {
          r = { ok: false, reason: `예외: ${err.message}`, cell, rep }
        }

        if (!r.ok) {
          if (r.reason === 'stale-skipped') {
            cellFailed = REPS
            break
          }
          cellFailed++
          failedReps++
          consecutiveFailures++
          if (consecutiveFailures >= FAILURE_STREAK_LIMIT) {
            console.error(
              `\n연속 실패 ${consecutiveFailures}회(마지막 사유: ${r.reason}) — 브라우저나 서버가` +
                ` 죽었을 가능성이 높다. 조용히 낭비하는 대신 중단한다.`,
            )
            await load.stop().catch(() => {})
            await browser.close().catch(() => {})
            process.exit(1)
          }
          continue
        }
        consecutiveFailures = 0
        if (rep < 0) continue // 워밍업은 기록하지 않는다

        const row = {
          cellId: id,
          ...cell,
          rep,
          load: cell.load,
          vus,
          /*
           * 이 셀을 시작할 때 실측한 서버 CPU. `vus`는 설정값이고 이쪽이 관측값이다 —
           * 둘을 함께 남겨야 "부하가 실제로 걸려 있었는가"를 사후에 확인할 수 있다.
           *
           * 창 길이를 함께 남긴다. 셀당 한 표본이라 창이 짧으면 값이 부하 수준이 아니라
           * 잡음을 가리키고, 창을 바꾼 전후의 행이 한 데이터셋에 섞인다 — 그 구분이
           * 행 안에 없으면 사후에 복원할 수 없다. run2의 앞부분 60셀이 2초 창이다.
           */
          serverCpuPct: guard.cpuPct,
          serverCpuWindowMs: verifier.observeMs,
          ts: Date.now(),
          ...r.metrics,
          /*
           * attribution을 함께 남긴다. 이것이 빠지면 "모드 간 차이가 어디서 생기는지"를
           * 사후에 분해할 수 없고(설계 문서 §7), 분산이 큰 셀을 만났을 때
           * 원인이 TTFB인지 리소스 로드인지 렌더 지연인지 — 혹은 LCP 요소 자체가
           * 실행마다 바뀐 것인지 — 구분할 방법이 사라진다.
           */
          attribution: r.attribution,
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
