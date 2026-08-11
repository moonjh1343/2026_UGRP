/**
 * 5단계 검증: **반복 30회의 분산이 모드 간 차이보다 작은가** (설계 문서 §12).
 *
 * 이 검증이 통과하지 못하면 factorial 수집을 시작해선 안 된다. 노이즈가 신호보다 크면
 * 8,800셀을 모아도 결정 경계가 나오지 않고, 그때는 이미 264,000회를 버린 뒤다.
 *
 * 판정식은 `pooled_within_sd / (max_median − min_median) < 0.5`.
 *
 * "모든 모드 쌍이 통계적으로 분리되는가"를 기준으로 삼지 않는 이유가 중요하다.
 * 3단계 실측에서 대시보드·폼·개인화형은 상위 3개 모드가 실제로 노이즈 안에 있었고,
 * 그것은 측정 실패가 아니라 **참인 발견**이다(그래서 마진 폴백 τ가 필요하다).
 * 5단계가 물어야 하는 것은 "그런 결론을 내릴 만큼 반복 노이즈가 작은가"이지
 * "차이가 항상 존재하는가"가 아니다.
 *
 * 사용:
 *   node verify-variance.mjs                          # 기본: 3유형 × Idle × low/3g-fast
 *   node verify-variance.mjs --reps 30 --types content,dashboard,form
 */
import { chromium } from 'playwright'
import { startLoad, loadProfile } from '../load/generator.mjs'
import { arg, list } from './lib/args.mjs'
import { captureEnv } from './lib/env.mjs'
import { loadCalibration, loadRouteTable, makeRng, shuffle } from './lib/grid.mjs'
import { measureOnce } from './lib/measure.mjs'
import { median, removeOutliers, robustSd, seMedian, varianceVerdict } from './lib/stats.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'


const REPS = Number(arg('reps', 30))
const WARMUP = Number(arg('warmup', 3))
const SEED = arg('seed', 'ugrp-2026')
const DEVICE = arg('device', 'low') // CPU 4× — 스로틀링 없이는 모드 차이가 노이즈에 묻힌다
const NETWORK = arg('network', '3g-fast')
const LOAD = arg('load', 'idle')
const TYPES = list('types', ['content', 'dashboard', 'form'])
/** 합격 임계값 — 모드 간 폭이 반복 노이즈의 최소 2배여야 한다 */
const THRESHOLD = Number(arg('threshold', 0.5))

/**
 * QoE 점검용 합성 점수. 제안서 §3.1의 가중 합을 단순화한 것으로,
 * **순위 판정에만** 쓴다. 실제 목적함수 J는 라우트별 z-정규화 후 계산된다.
 */
const score = (m) => (m.LCP ?? NaN) + 2 * (m.TBT ?? 0)

const table = await loadRouteTable(BASE)
const calibration = await loadCalibration()
const profile = await loadProfile()

const routes = TYPES.map((t) => {
  const of = table.routes.filter((r) => r.type === t)
  return of[Math.floor(of.length / 2)] // 중앙값 인스턴스
}).filter(Boolean)

if (routes.length === 0) {
  console.error(`알 수 없는 유형: ${TYPES.join(', ')}`)
  process.exit(1)
}

const browser = await chromium.launch()
const env = await captureEnv({ base: BASE, browser, seeds: { order: SEED } })

console.log(`\n5단계 검증 — 반복 ${REPS}회 (워밍업 ${WARMUP})`)
console.log(`  조건: ${DEVICE} · ${NETWORK} · 부하 ${LOAD}`)
console.log(`  브라우저 ${env.browser.version} · Node ${env.node} · Next ${env.next} · 시드 ${SEED}`)
console.log(`  판정: pooled_sd / 모드간_폭 < ${THRESHOLD}\n`)

const vus = LOAD === 'idle' ? 0 : (calibration?.levels?.[LOAD]?.vus ?? null)
if (vus === null) {
  console.error(`부하 '${LOAD}'의 캘리브레이션이 없다 — load/calibrate.mjs를 먼저 실행하라`)
  await browser.close()
  process.exit(1)
}

const load = await startLoad({ vus, profile })
if (vus > 0) await new Promise((r) => setTimeout(r, 10_000))

const rng = makeRng(SEED)
const report = []

try {
  for (const route of routes) {
    /*
     * SSG는 캐시 상태를 고정한다. 통제하지 않으면 한 셀 안에서 미스와 히트가 섞여
     * 분산이 폭발하는데, 그게 바로 이 검증이 잡아내야 하는 것이다(§11-3).
     * 여기서는 `hit`으로 고정한다 — 정상 운영 상태의 SSG를 뜻한다.
     */
    const cells = route.candidateModes.map((mode) => ({
      device: DEVICE,
      network: NETWORK,
      load: LOAD,
      routeType: route.type,
      routeKey: route.key,
      mode,
      cache: mode === 'ssg' ? 'hit' : 'n/a',
    }))

    /*
     * 반복 × 모드를 통째로 펼쳐 무작위 순서로 돈다.
     *
     * 모드별로 30회씩 몰아서 돌면 각 모드가 **서로 다른 시간대**를 점유해, 그 시간대의
     * 인프라 상태(열, GC, 캐시)가 모드 효과로 잘못 귀속된다. 인터리빙이 이 연구에서
     * 선택이 아닌 이유다.
     */
    const plan = shuffle(
      cells.flatMap((cell) =>
        Array.from({ length: REPS + WARMUP }, (_, i) => ({ cell, rep: i - WARMUP })),
      ),
      rng,
    )

    const samples = {}
    for (const m of route.candidateModes) {
      samples[m] = []
    }
    let failed = 0
    /*
     * 실행 순서대로의 벽시계 시간. **환경 드리프트 감지용**이다.
     *
     * 반복 × 모드를 인터리빙했으므로 머신이 중간에 바빠지면 그 영향이 모든 모드에
     * 골고루 퍼진다 — 순위는 지켜지지만 분산이 폭발해 판정이 FAIL로 뒤집힌다.
     * 그때 "노이즈가 크다"만 보고하면 원인을 앱에서 찾게 되므로, 시간에 따른
     * 추세를 함께 남겨 **측정 환경이 원인인지** 바로 구분할 수 있게 한다.
     */
    const timeline = []

    process.stdout.write(`  ${route.type}/${route.key}  `)
    let n = 0
    for (const { cell, rep } of plan) {
      // run.mjs와 같은 이유로 예외를 잡는다 — 타임아웃 한 번에 검증 전체가 죽으면 안 된다.
      let r
      try {
        r = await measureOnce({ base: BASE, browser, cell, rep, allowStale: false })
      } catch (err) {
        r = { ok: false, reason: `예외: ${err.message}` }
      }
      if (!r.ok) {
        failed++
        continue
      }
      if (rep < 0) continue // 워밍업 제외

      timeline.push(r.wallMs)
      const s = score(r.metrics)
      if (Number.isFinite(s)) samples[cell.mode].push(s)
      if (++n % 20 === 0) process.stdout.write('.')
    }
    process.stdout.write('\n')

    // 제안서 §5.2: MAD 기준 3σ 이상치 제거
    const cleaned = {}
    let outliers = 0
    for (const [m, xs] of Object.entries(samples)) {
      const { kept, removed } = removeOutliers(xs)
      cleaned[m] = kept
      outliers += removed.length
    }

    const totalSamples = Object.values(samples).reduce((s, xs) => s + xs.length, 0)
    const outlierRate = totalSamples === 0 ? 0 : outliers / totalSamples

    // 전반부 대비 후반부 벽시계 중앙값 — 1에서 멀수록 실행 중에 환경이 **지속적으로** 변했다
    const half = Math.floor(timeline.length / 2)
    const driftRatio =
      half > 2 ? median(timeline.slice(half)) / median(timeline.slice(0, half)) : NaN

    /*
     * 스파이크 비율 — 중앙값의 3배를 넘는 반복의 비율.
     *
     * 드리프트(전반/후반 비교)는 **지속적** 변화만 잡는다. 네트워크 단절이나 다른
     * 프로세스의 순간 부하처럼 **간헐적** 사건은 전반·후반 중앙값을 거의 바꾸지 않으면서
     * 분산만 폭발시킨다. 실제로 5단계 재측정 한 번이 이렇게 실패했다 — 순위까지 뒤섞이고
     * MAD가 두 자릿수에서 네 자릿수로 튀었는데 중앙값 추세는 밋밋했다.
     *
     * 측정은 127.0.0.1로만 나가지만 브라우저 프로세스는 그렇지 않다. NIC가 끊기면
     * Chrome이 DNS·연결 재시도를 반복하고, 그 CPU가 스로틀링된 렌더러와 같은 코어를
     * 두고 경쟁한다. `networkidle` 대기도 함께 밀린다.
     */
    const wallMedian = median(timeline)
    const spikes = timeline.filter((w) => w > wallMedian * 3).length
    const spikeRate = timeline.length === 0 ? 0 : spikes / timeline.length

    const verdict = varianceVerdict(cleaned, { threshold: THRESHOLD })
    report.push({
      route,
      verdict,
      cleaned,
      failed,
      outliers,
      outlierRate,
      driftRatio,
      spikeRate,
      wallMedian,
    })

    if (!verdict) {
      console.log('    판정 불가 — 유효 표본이 부족하다\n')
      continue
    }

    console.log(
      `    ${'모드'.padEnd(9)}${'중앙값'.padStart(9)}${'MAD·σ'.padStart(9)}` +
        `${'SE'.padStart(8)}${'n'.padStart(5)}`,
    )
    for (const { mode } of verdict.medians) {
      const xs = cleaned[mode]
      console.log(
        `    ${mode.padEnd(9)}${median(xs).toFixed(0).padStart(9)}` +
          `${robustSd(xs).toFixed(0).padStart(9)}` +
          `${seMedian(xs).toFixed(1).padStart(8)}${String(xs.length).padStart(5)}`,
      )
    }
    console.log(
      `    폭=${verdict.spread.toFixed(0)}  pooled_sd=${verdict.pooledSd.toFixed(1)}  ` +
        `분산비=${verdict.ratio.toFixed(3)}  ${verdict.pass ? 'OK' : 'FAIL'}` +
        `${failed ? `  (실패 반복 ${failed})` : ''}${outliers ? `  (이상치 ${outliers})` : ''}`,
    )
    /*
     * 분해능을 함께 보고한다. 분산비만으로는 CSR처럼 혼자 크게 떨어진 모드가 폭을 지배해
     * 나머지가 전혀 구분되지 않아도 통과한다 — 정책이 하는 일은 argmin이므로
     * 순위 맨 위를 분해할 수 있는지가 실제 질문이다.
     */
    console.log(
      `    1·2위 간극=${verdict.topGap.toFixed(0)}  분해능=${
        Number.isFinite(verdict.resolution) ? verdict.resolution.toFixed(2) : '∞'
      }  인접쌍 분리 ${verdict.separatedPairs}/${verdict.pairs.length}`,
    )
    console.log(
      `    최우수 ${verdict.best}${verdict.topPairSeparated ? ' — 2위와 유의하게 분리' : ' — 2위와 노이즈 안 (마진 폴백 영역)'}`,
    )
    /*
     * 이상치 제거율이 높다는 것은 분포가 단봉이 아니라는 신호다(느린 경로가 따로 있다).
     * MAD 트리밍은 그것을 **고치는 게 아니라 가린다** — 3σ 밖을 잘라내면 겉보기 분산은
     * 줄지만, 실제로는 두 개의 서로 다른 조건을 한 셀로 부르고 있었던 것일 수 있다.
     * 제거율이 10%를 넘으면 셀 정의를 의심해야 한다(캐시 상태·배경 프로세스·GC).
     */
    console.log(
      `    벽시계 중앙값=${wallMedian.toFixed(0)}ms  드리프트(후반/전반)=${
        Number.isFinite(driftRatio) ? driftRatio.toFixed(2) : '-'
      }  스파이크(>3×)=${spikes}/${timeline.length}`,
    )
    if (spikeRate > 0.05) {
      console.log(
        `    주의: 반복의 ${(spikeRate * 100).toFixed(0)}%가 중앙값의 3배를 넘었다 — ` +
          `간헐적 외부 사건(네트워크 단절·다른 프로세스의 순간 부하)의 모양이다. ` +
          `앱을 의심하기 전에 측정 환경을 확인하라.`,
      )
    }
    if (Number.isFinite(driftRatio) && Math.abs(driftRatio - 1) > 0.25) {
      console.log(
        `    주의: 실행 중 벽시계가 ${driftRatio > 1 ? '느려' : '빨라'}졌다 ` +
          `(후반/전반 = ${driftRatio.toFixed(2)}). 앱이 아니라 **측정 환경**이 변했다는 신호다 — ` +
          `다른 프로세스를 정리하고 다시 측정하라.`,
      )
    }
    if (outlierRate > 0.1) {
      console.log(
        `    주의: 이상치 제거율 ${(outlierRate * 100).toFixed(0)}% — 분포가 단봉이 아닐 수 있다. ` +
          `셀 정의(캐시 상태·배경 프로세스)를 의심하라.`,
      )
    }
    console.log('')
  }
} finally {
  await load.stop()
  await browser.close()
}

// ------------------------------------------------------------------- 결과

const judged = report.filter((r) => r.verdict)
const failures = judged.filter((r) => !r.verdict.pass)

console.log('요약')
for (const r of judged) {
  console.log(
    `  ${r.route.type.padEnd(13)}분산비 ${r.verdict.ratio.toFixed(3)}  ` +
      `분해능 ${Number.isFinite(r.verdict.resolution) ? r.verdict.resolution.toFixed(2) : '∞'}  ` +
      `분리 ${r.verdict.separatedPairs}/${r.verdict.pairs.length}  ` +
      `최우수 ${r.verdict.best}  ${r.verdict.pass ? 'OK' : 'FAIL'}`,
  )
}

const unresolved = judged.filter((r) => !r.verdict.topPairSeparated)
if (unresolved.length > 0) {
  console.log(
    `\n  ${unresolved.map((r) => r.route.type).join(', ')}에서 1·2위가 노이즈 안에 있다.`,
  )
  console.log('  이는 실패가 아니라 발견이다 — 마진 폴백(τ)이 실제로 필요한 영역이 여기다.')
}

if (judged.length === 0) {
  console.error('\n판정 가능한 유형이 없다 — 5단계 검증 실패')
  process.exit(1)
}
if (failures.length > 0) {
  console.error(
    `\n${failures.length}개 유형에서 반복 노이즈가 모드 간 차이에 비해 크다 — 5단계 검증 실패`,
  )
  console.error('factorial 수집을 시작하면 안 된다. 노이즈가 신호보다 크면 결정 경계가 나오지 않는다.')

  const environmental = failures.filter(
    (r) =>
      r.spikeRate > 0.05 || (Number.isFinite(r.driftRatio) && Math.abs(r.driftRatio - 1) > 0.25),
  )
  if (environmental.length === failures.length) {
    console.error(
      '\n실패한 유형 전부에서 벽시계 스파이크 또는 드리프트가 관측됐다 — ' +
        '원인은 앱이 아니라 **측정 환경**일 가능성이 높다.',
    )
    console.error(
      '네트워크 연결과 다른 프로세스(브라우저·미디어·동기화 클라이언트)를 정리하고 다시 측정하라.',
    )
  } else {
    console.error('점검 순서: 반복 수 · 스로틀링 강도 · 배경 프로세스 · SSG 캐시 상태 고정 여부.')
  }
  process.exit(1)
}
console.log(`\n${judged.length}개 유형 전부 반복 노이즈 < 모드 간 차이 — 5단계 검증 통과`)
