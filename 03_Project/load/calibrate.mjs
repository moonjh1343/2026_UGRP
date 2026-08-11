/**
 * 부하 캘리브레이션 — 목표 CPU에 도달하는 VU 수를 이진 탐색한다.
 *
 * 왜 이진 탐색인가: "CPU 65%"는 조건이지 명령이 아니다. VU 수와 CPU의 관계는 하드웨어·
 * 라우트 믹스·Node 버전에 따라 달라지므로 미리 알 수 없다. 한 번 찾아서 **셀 정의에
 * 고정**하고, 이후 측정에서는 그 VU 수를 그대로 쓴다.
 *
 * 왜 측정 중에 CPU를 피드백 제어하지 않는가: 제어기가 붙으면 부하가 측정 요청에 반응하게
 * 되어 **외생성이 깨진다.** 렌더 모드가 서버 부하를 바꾸고 그 부하가 피처인데, 부하가
 * 다시 모드에 반응하면 인과 방향이 닫힌 고리가 된다. 그래서 캘리브레이션은 측정 **전에**
 * 끝내고, 측정 중에는 VU 수를 얼린다.
 *
 * 산출: calibration.generated.json — 셀 정의의 일부이므로 버전 관리 대상이다.
 * 사용: (앱을 프로덕션 빌드로 띄운 뒤) node calibrate.mjs
 */
import { writeFile } from 'node:fs/promises'
import { loadProfile, startLoad } from './generator.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

/** 부하를 건 뒤 CPU가 안정될 때까지 기다리는 시간. 짧으면 상승 구간을 재게 된다. */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 8000)
/** 안정 후 관측 시간. **이 구간 전체를 한 번의 델타로** 잰다 — 아래 measureAt 주석 참조. */
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 20000)
const MAX_VUS = Number(process.env.MAX_VUS ?? 256)
/** 목표 CPU와의 허용 오차(%p). 이보다 가까우면 탐색을 멈춘다. */
const TOLERANCE = Number(process.env.TOLERANCE ?? 4)
/*
 * 지속 확인 단계 — loadControl.mjs의 calibrateRemote와 같은 구조.
 *
 * **짧은 버스트로 잰 VU→CPU 대응은 지속 상태에서 성립하지 않는다.** 고정 VU는
 * 동시성을 고정할 뿐이고, 닫힌 루프에서 처리율 = 동시성 / (thinkTime + 응답시간)이라
 * 서버가 포화에 가까워지면 응답시간이 늘어 CPU가 내려앉는다. slice-b2에서 세 부하
 * 수준 모두 지속 CPU가 버스트보다 12~16%p 낮았다. 그 수정(c66d7c8)이 원격 경로에만
 * 들어가고 이 파일은 버스트 전용으로 남아 있었다 — 로컬로 부하 셀을 수집하는 순간
 * run.mjs가 이 파일의 cpuPct를 기대값으로 쓰므로, mid·high는 이탈 감시(±12%p)에
 * 걸려 중단되고 low는 걸리지 않은 채 부하 축이 부풀려진 라벨로 수집된다.
 */
const HOLD_SETTLE_MS = Number(process.env.HOLD_SETTLE_MS ?? 30_000)
const HOLD_MS = Number(process.env.HOLD_MS ?? 180_000)
const HOLD_ROUNDS = Number(process.env.HOLD_ROUNDS ?? 4)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function snapshot() {
  const res = await fetch(`${BASE}/api/internal/metrics`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`메트릭 조회 실패: HTTP ${res.status}`)
  return res.json()
}

/**
 * 주어진 VU 수에서의 CPU 사용률을 잰다.
 *
 * `/api/internal/metrics`는 **조회 사이의 CPU 델타**를 반환한다. 따라서 첫 조회는
 * 기준점을 리셋하기 위한 것이고 값은 버린다.
 *
 * **1초 델타의 중앙값을 쓰면 안 된다.** think time이 1초인 환경에서는 1초 창에 요청이
 * 0건이거나 2건이라 표본 자체가 튀고, 중앙값을 취해도 VU에 대해 단조롭지 않은 곡선이
 * 나온다(실측: VU 2→14.5%, 4→9.2%, 8→36.9%, 16→61.3%, 32→49.4%). 이진 탐색은
 * 단조성을 가정하므로 그 위에서는 헤맨다.
 *
 * 관측 구간 **전체를 한 번의 델타**로 재면 정의상 그 구간의 평균 사용률이 되고,
 * 표본 분산이 사라진다. 재려는 값이 애초에 "이 부하에서의 평균 CPU"이므로
 * 추정량으로도 이쪽이 옳다.
 */
/**
 * VU→측정값 메모.
 *
 * 목표 수준마다 VU=1부터 다시 훑으면 이미 아는 점을 반복 측정한다. 프로브 하나가
 * 31초이므로 그 낭비가 실행 시간을 두 배로 만들고, 길어질수록 중간에 죽을 확률도 커진다
 * (실제로 한 번 죽었다). 부하-CPU 관계는 같은 실행 안에서 바뀌지 않으므로 재사용해도 된다.
 */
const memo = new Map()

async function measureAt(vus, profile) {
  if (memo.has(vus)) return memo.get(vus)
  const result = await measureFresh(vus, profile)
  memo.set(vus, result)
  return result
}

async function measureFresh(vus, profile, { settleMs = SETTLE_MS, observeMs = OBSERVE_MS } = {}) {
  const load = await startLoad({ vus, profile })
  try {
    await sleep(settleMs)
    await snapshot() // 델타 기준점 리셋 — 값은 버린다 (부하 이전 구간이 섞여 있다)

    await sleep(observeMs)
    const s = await snapshot()

    return {
      cpuPct: s.cpuPct,
      eventLoopP95Ms: s.eventLoopP95Ms,
      requests: load.stats.requests,
    }
  } finally {
    await load.stop()
    // 다음 측정이 이전 부하의 꼬리를 재지 않도록 가라앉힌다
    await sleep(3000)
  }
}

/** 지속 상태 측정 — 메모하지 않는다(버스트와 창이 달라 다른 양이다). */
async function holdAt(vus, profile) {
  return measureFresh(vus, profile, { settleMs: HOLD_SETTLE_MS, observeMs: HOLD_MS })
}

// --------------------------------------------------------------------------

const profile = await loadProfile()
const targets = Object.entries(profile.targets).filter(([, pct]) => pct > 0)

console.log(`\n부하 캘리브레이션 — ${BASE}`)
console.log(`  믹스: ${profile.routes.map((r) => `${r.key}×${r.weight}`).join(', ')} (${profile.mode})`)
console.log(
  `  탐색: 안정 ${SETTLE_MS / 1000}s + 관측 ${OBSERVE_MS / 1000}s · ` +
    `지속 확인: 안정 ${HOLD_SETTLE_MS / 1000}s + 관측 ${HOLD_MS / 1000}s × 최대 ${HOLD_ROUNDS}회 · ` +
    `허용 오차 ±${TOLERANCE}%p\n`,
)

const probe = await snapshot()
console.log(`  할당 코어 ${probe.allocatedCores ?? '?'} (머신 ${probe.cpuCount}코어) — 부하 %는 할당 CPU 기준이다\n`)

const idle = await measureAt(0, profile)
console.log(`  Idle             cpu=${idle.cpuPct.toFixed(1)}%  루프지연p95=${idle.eventLoopP95Ms.toFixed(2)}ms`)

const results = { idle: { vus: 0, ...idle } }

// 목표를 오름차순으로 돈다 — 낮은 수준의 확정 VU가 다음 수준의 하한이 된다
targets.sort((a, b) => a[1] - b[1])
let floorVus = 1

for (const [name, target] of targets) {
  /*
   * 상한을 먼저 넓힌다(exponential probe). 이진 탐색만으로 시작하면 상한(MAX_VUS)에서
   * 한 번 재야 하는데, 목표가 낮을 때 그 한 번이 서버를 포화시켜 이후 측정이 오염된다.
   *
   * 시작점은 이전(더 낮은) 수준의 확정 VU다. CPU는 VU에 대해 단조 증가하므로
   * 그 아래는 볼 필요가 없고, 30%를 맞춘 VU에서 65%를 찾기 시작하는 것이 옳다.
   */
  let lo = floorVus
  let hi = floorVus
  let hiCpu = 0
  /*
   * 두 배씩 올리되 **상한에서 한 번은 반드시 잰다.**
   *
   * `while (hi <= MAX_VUS)`로 두면 hi가 상한을 넘는 순간 루프가 빠져나가면서
   * 마지막으로 잰 값(더 낮은 VU의 값)을 상한의 값인 것처럼 보고한다.
   * 실측에서 "VU 96에서도 81.5%"라고 출력했는데 96은 측정한 적조차 없었다 —
   * 측정하지 않은 값을 셀 정의에 적는 것이라 반드시 막아야 한다.
   */
  while (true) {
    const m = await measureAt(hi, profile)
    console.log(`  ${name.padEnd(6)} 탐색 VU=${String(hi).padStart(3)}  cpu=${m.cpuPct.toFixed(1)}%`)
    hiCpu = m.cpuPct
    if (m.cpuPct >= target) break
    if (hi >= MAX_VUS) break
    lo = hi
    hi = Math.min(MAX_VUS, hi * 2)
  }

  if (hiCpu < target) {
    console.log(
      `  ${name.padEnd(6)} 경고: VU ${hi}(상한 ${MAX_VUS})에서도 ${hiCpu.toFixed(1)}% — 목표 ${target}% 미달`,
    )
    results[name] = { vus: hi, cpuPct: hiCpu, target, reached: false }
    continue
  }

  let burst = { vus: hi, cpuPct: hiCpu }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const m = await measureAt(mid, profile)
    console.log(`  ${name.padEnd(6)} 탐색 VU=${String(mid).padStart(3)}  cpu=${m.cpuPct.toFixed(1)}%`)

    if (Math.abs(m.cpuPct - target) < Math.abs(burst.cpuPct - target)) {
      burst = { vus: mid, cpuPct: m.cpuPct }
    }
    if (Math.abs(m.cpuPct - target) <= TOLERANCE) break
    if (m.cpuPct < target) lo = mid
    else hi = mid
  }

  /*
   * 2단계: 지속 상태 확인 + 비례 보정. 이진 탐색은 이웃을 싸게 찾는 용도이고,
   * 기록에 남는 cpuPct는 **지속값**이다 — run.mjs의 이탈 감시가 측정 중에 비교하는
   * 값이 바로 이것이어야 한다. calibrateRemote와 같은 감쇠(0.7) 비례 보정.
   */
  let vus = burst.vus
  let best = null
  let round = 0
  while (round < Math.max(1, HOLD_ROUNDS)) {
    round++
    const h = await holdAt(vus, profile)
    console.log(
      `  ${name.padEnd(6)} 지속 확인 ${round}/${HOLD_ROUNDS} VU=${String(vus).padStart(3)}  ` +
        `cpu=${h.cpuPct.toFixed(1)}% (목표 ${target}% · 버스트 ${burst.cpuPct.toFixed(1)}%)`,
    )
    if (best === null || Math.abs(h.cpuPct - target) < Math.abs(best.cpuPct - target)) {
      best = { vus, cpuPct: h.cpuPct, eventLoopP95Ms: h.eventLoopP95Ms }
    }
    if (Math.abs(h.cpuPct - target) <= TOLERANCE) break

    // 포화 근처에서 VU→CPU 기울기가 완만해지므로 순수 비례로 밀면 넘겨 짚고 진동한다.
    const scale = h.cpuPct > 0 ? target / h.cpuPct : 2
    const next = Math.max(1, Math.min(MAX_VUS, Math.round(vus * (1 + (scale - 1) * 0.7))))
    if (next === vus) {
      console.log(`  ${name.padEnd(6)} 지속 확인 — VU ${vus}에서 보정할 여지가 없다 (상한 ${MAX_VUS})`)
      break
    }
    vus = next
  }

  results[name] = {
    ...best,
    target,
    reached: Math.abs(best.cpuPct - target) <= TOLERANCE,
    // 버스트값도 남긴다 — 둘의 차이가 이 머신에서 닫힌 루프가 얼마나 물러나는지의 기록이다.
    burst: { ...burst },
    holdRounds: round,
    holdMs: HOLD_MS,
  }
  floorVus = Math.max(1, best.vus)
  console.log(
    `  ${name.padEnd(6)} 확정 VU=${best.vus}  지속 cpu=${best.cpuPct.toFixed(1)}% (목표 ${target}%)` +
      `${results[name].reached ? '' : ' — 허용 오차 초과'}`,
  )
}

const out = {
  note: 'calibrate.mjs 산출물. 셀 정의의 일부이므로 손으로 고치지 말 것. 하드웨어가 바뀌면 다시 돌린다.',
  generatedAt: new Date().toISOString(),
  base: BASE,
  // 부하 %의 분모. 이 값이 다르면 "부하 65%"가 다른 것을 뜻한다.
  allocatedCores: probe.allocatedCores ?? null,
  machineCores: probe.cpuCount ?? null,
  profileMode: profile.mode,
  routes: profile.routes,
  tolerance: TOLERANCE,
  levels: results,
}

await writeFile(
  new URL('./calibration.generated.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
)

const unreached = Object.entries(results).filter(([, v]) => v.reached === false)
console.log(`\n  → calibration.generated.json`)
if (unreached.length) {
  console.log(`  주의: ${unreached.map(([k]) => k).join(', ')} 수준이 목표에 도달하지 못했다.`)
  console.log('  이 상태로 수집하면 "부하 90%" 셀이 실제로는 다른 부하다 — 셀 정의가 거짓이 된다.')
  process.exit(1)
}
console.log('  전 수준 목표 도달 — 이 VU 수를 셀 정의에 고정한다\n')
