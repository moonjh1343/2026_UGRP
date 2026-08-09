/**
 * 원격 부하 생성기 제어 + 캘리브레이션 + 검증.
 *
 * 로컬에서는 `startLoad()`가 프로세스 안에서 부하를 돌린다. AWS에서는 부하가 별도
 * 태스크라, 워커가 HTTP로 VU 수를 지시하고 SUT의 CPU를 보며 이진 탐색한다. 반환
 * 객체는 `startLoad()`와 같은 모양이라(`{ vus, stats, stop }`) 호출부가 분기 없이 쓴다.
 *
 * 캘리브레이션이 워커 쪽에 있는 이유: 이진 탐색은 "VU를 놓고 → SUT의 CPU를 읽는다"의
 * 반복인데, CPU를 읽는 쪽은 워커다. 부하 생성기가 스스로 맞추게 하면 부하가 측정
 * 대상의 상태에 반응하는 제어 루프가 되어 외생성이 깨진다(calibrate.mjs 첫 주석).
 *
 * 측정 중에는 VU를 **얼린다.** 아래 `verifyLoad`는 관측하고 어긋나면 멈출 뿐,
 * 절대 보정하지 않는다.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * **제어 평면 요청에는 반드시 타임아웃이 있어야 한다.**
 *
 * `control.mjs`는 단일 Node 프로세스가 수십 개 동시 스트림의 본문을 읽으면서 자기
 * 제어 API도 서빙한다. 이벤트 루프가 굶으면 `/vus` POST의 본문조차 읽지 못하고,
 * 타임아웃이 없으면 undici 기본값 300초를 기다린 뒤 처리되지 않은 `fetch failed`로
 * **워커 프로세스가 죽는다.** SUT의 `/api/internal/metrics`도 서버가 포화되면 같다.
 *
 * slice-b2가 이렇게 죽었다(2026-08-09). high 샤드가 캘리브레이션 중 네 번 크래시했고,
 * Parallel이 나머지 세 샤드를 끌고 내려갔다. 로그의 5분 간격이 정확히 그 기본값이다.
 *
 * 응답이 늦은 것은 부하가 걸려 있다는 뜻이지 고장이 아니므로, 짧은 타임아웃으로
 * 끊고 다시 물어본다. 끝까지 안 되면 그때 던진다 — 호출부가 판단할 수 있는 오류로.
 */
async function fetchJson(url, { method = 'GET', body, timeoutMs = 30_000, attempts = 3, what } = {}) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method,
        cache: 'no-store',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      // 마지막 시도가 아니면 잠깐 쉬고 다시. 이벤트 루프가 풀릴 시간을 준다.
      if (i < attempts) await sleep(2000 * i)
    }
  }
  throw new Error(`${what} 실패 (${attempts}회 시도): ${lastErr?.message ?? lastErr}`)
}

async function post(controlUrl, path, body) {
  // VU 변경은 이전 부하를 전부 정리하고서 응답한다 — 그만큼 넉넉하게 준다.
  return fetchJson(`${controlUrl}${path}`, { method: 'POST', body, timeoutMs: 60_000, what: `부하 제어 ${path}` })
}

async function get(controlUrl, path) {
  return fetchJson(`${controlUrl}${path}`, { what: `부하 제어 ${path}` })
}

/** SUT의 CPU 스냅샷. 조회 사이의 델타를 돌려주므로 첫 조회는 기준점 리셋이다. */
async function snapshot(base) {
  return fetchJson(`${base}/api/internal/metrics`, { what: '메트릭 조회' })
}

/**
 * 주어진 VU에서의 평균 CPU.
 *
 * **관측 구간 전체를 한 번의 델타로 잰다.** 1초 델타의 중앙값을 쓰면 think time이
 * 1초인 환경에서 표본이 튀고 VU에 대해 단조롭지 않은 곡선이 나온다 —
 * calibrate.mjs가 실측으로 확인한 사실이고, 이진 탐색은 단조성을 가정한다.
 */
async function measureAt({ base, controlUrl, vus, settleMs, observeMs }) {
  await post(controlUrl, '/vus', { vus })
  await sleep(settleMs)
  await snapshot(base) // 기준점 리셋 — 값은 버린다
  await sleep(observeMs)
  const m = await snapshot(base)
  return { vus, cpuPct: m.cpuPct, eventLoopP95Ms: m.eventLoopP95Ms }
}

/**
 * 목표 CPU에 도달하는 VU 수를 찾는다. calibrate.mjs와 같은 알고리즘 —
 * 지수 탐침으로 상한을 넓힌 뒤 이진 탐색.
 *
 * Fargate에서 다시 돌려야 하는 이유: `load/calibration.generated.json`의 값은
 * 18코어 머신에서 1코어를 할당한 기준이다. 태스크 크기가 다르면 VU→CPU 대응이
 * 통째로 달라지고, 그대로 쓰면 부하 수준이 그리드가 말하는 것과 다른 값이 된다.
 *
 * ------------------------------------------------------------------ 2단계 구조
 *
 * **짧은 버스트로 잰 VU→CPU 대응은 지속 상태에서 성립하지 않는다.**
 *
 * 고정 VU는 CPU를 고정하는 게 아니라 **동시성**을 고정한다. 닫힌 루프에서
 * 처리율 = 동시성 / (thinkTime + 응답시간)이고, 서버가 포화에 가까워지면 응답시간이
 * 늘어나 처리율이 내려가고 CPU도 함께 내려간다. 20초 관측창은 응답시간이 새 평형에
 * 닿기 전의 과도 상태를 잡는다. 반면 측정은 셀당 수 분씩 돌아가므로 평형값을 본다.
 *
 * slice-b2에서 세 부하 수준 모두 지속 CPU가 버스트 캘리브레이션보다 12~16%p 낮았다
 * (low 15.0 vs 27.4 · mid 51.3 vs 64.6 · high 74.5 vs 89.0). 리스너 누수와는 무관한
 * 별개 원인이고, 이탈 감시가 셋 다 잡아냈다.
 *
 * 그래서 이진 탐색은 **이웃을 싸게 찾는 용도로만** 쓰고, 고른 VU를 몇 분 유지해
 * 평형 CPU를 재고, 목표에서 벗어나면 VU를 비례 보정해 다시 유지한다. 기록에 남는
 * `cpuPct`는 **지속 상태의 값**이다 — 이탈 감시가 측정 중에 비교하는 그 값이어야 한다.
 *
 * **이것은 측정 중 제어 루프가 아니다.** 전부 측정 시작 전에 끝나고, 그 뒤 VU는
 * 얼린다. 부하가 측정 대상에 반응하면 외생성이 깨진다는 규칙은 그대로다.
 */
export async function calibrateRemote({
  base,
  controlUrl,
  target,
  tolerance = 4,
  maxVus = 256,
  settleMs = 8000,
  observeMs = 20000,
  /** 지속 확인 — 안정화 30초 + 관측 3분. 평형에 닿기에 충분하고 셀 하나 값보다 짧다. */
  holdSettleMs = 30_000,
  holdMs = 180_000,
  holdRounds = 4,
  log = console.log,
}) {
  if (target <= 0) return { vus: 0, cpuPct: 0, target, reached: true }

  const at = (vus) => measureAt({ base, controlUrl, vus, settleMs, observeMs })

  let lo = 0
  let hi = 1
  let m = await at(hi)
  log(`  캘리브레이션 탐침 VU=${hi} cpu=${m.cpuPct.toFixed(1)}%`)
  while (m.cpuPct < target && hi < maxVus) {
    lo = hi
    hi = Math.min(maxVus, hi * 2)
    m = await at(hi)
    log(`  캘리브레이션 탐침 VU=${hi} cpu=${m.cpuPct.toFixed(1)}%`)
  }

  let burst = { vus: hi, cpuPct: m.cpuPct }
  if (m.cpuPct < target) {
    log(`  경고: VU ${hi}(상한 ${maxVus})에서도 버스트 ${m.cpuPct.toFixed(1)}% — 목표 ${target}% 미달`)
  } else {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const r = await at(mid)
      log(`  캘리브레이션 이분 VU=${mid} cpu=${r.cpuPct.toFixed(1)}%`)
      if (Math.abs(r.cpuPct - target) < Math.abs(burst.cpuPct - target)) burst = { vus: mid, cpuPct: r.cpuPct }
      if (Math.abs(r.cpuPct - target) <= tolerance) break
      if (r.cpuPct < target) lo = mid
      else hi = mid
    }
  }

  // ---------------------------------------------------- 2단계: 지속 상태 확인
  let vus = burst.vus
  let best = null
  let round = 0
  while (round < Math.max(1, holdRounds)) {
    round++
    const h = await measureAt({ base, controlUrl, vus, settleMs: holdSettleMs, observeMs: holdMs })
    log(
      `  지속 확인 ${round}/${holdRounds} VU=${vus} cpu=${h.cpuPct.toFixed(1)}% ` +
        `(목표 ${target}% · 버스트 ${burst.cpuPct.toFixed(1)}%)`,
    )
    if (best === null || Math.abs(h.cpuPct - target) < Math.abs(best.cpuPct - target)) best = h
    if (Math.abs(h.cpuPct - target) <= tolerance) break

    /*
     * 비례 보정에 감쇠를 건다. 포화 근처에서 VU→CPU 기울기가 완만해지므로 순수
     * 비례(target/cpu)로 밀면 넘겨 짚고 진동한다.
     */
    const scale = h.cpuPct > 0 ? target / h.cpuPct : 2
    const next = Math.max(1, Math.min(maxVus, Math.round(vus * (1 + (scale - 1) * 0.7))))
    if (next === vus) {
      log(`  지속 확인 — VU ${vus}에서 보정할 여지가 없다 (상한 ${maxVus})`)
      break
    }
    vus = next
  }

  const reached = Math.abs(best.cpuPct - target) <= tolerance
  if (!reached) {
    log(`  경고: 지속 상태 ${best.cpuPct.toFixed(1)}% — 목표 ${target}%에 ${holdRounds}회 안에 못 맞췄다`)
  }
  /*
   * `cpuPct`는 지속값이다. 버스트값도 남긴다 — 둘의 차이가 이 태스크 크기에서
   * 닫힌 루프가 얼마나 물러나는지의 기록이고, 사후에 부하 축을 해석할 때 쓴다.
   */
  return {
    ...best,
    target,
    reached,
    holdRounds: round,
    holdMs,
    burst: { ...burst },
  }
}

/**
 * 부하를 0으로 되돌린다. **캘리브레이션 전 위생 절차다.**
 *
 * 부하 태스크는 워커보다 오래 산다. 앞선 워커가 죽었다면 부하는 그 워커가 마지막에
 * 지시한 VU로 계속 돌고 있고, 그 위에서 첫 탐침을 하면 두 부하가 겹친 값을 잰다 —
 * 게다가 `setVus`가 수십 개 스트림을 정리하는 동안 제어 서버가 응답하지 못한다.
 *
 * 실패해도 던지지 않는다. 여기서 막히면 뒤따르는 캘리브레이션도 막히고, 재시도는
 * 그쪽에서 세는 것이 맞다 — 위생 절차가 시도 횟수를 먹으면 진단이 흐려진다.
 */
export async function resetRemoteLoad(controlUrl, { log = console.log } = {}) {
  try {
    const before = await get(controlUrl, '/state').catch(() => null)
    if (before && before.vus === 0) return { vus: 0, wasRunning: false }
    if (before) log(`  부하 초기화 — 이전 워커가 남긴 VU ${before.vus}를 0으로 되돌린다`)
    await post(controlUrl, '/vus', { vus: 0 })
    // 정리된 요청이 SUT에서 빠져나갈 시간. 이걸 안 주면 첫 탐침이 잔열을 함께 잰다.
    await sleep(5000)
    return { vus: 0, wasRunning: Boolean(before && before.vus > 0) }
  } catch (err) {
    log(`  부하 초기화 실패(${err.message}) — 캘리브레이션에서 다시 시도한다`)
    return { vus: null, wasRunning: null }
  }
}

/**
 * 원격 부하를 붙잡는 핸들. `startLoad()`와 같은 모양이라 호출부가 분기하지 않는다.
 *
 * stop()이 VU를 0으로 되돌리는 것에 주의 — 태스크를 죽이지는 않는다. 태스크의
 * 수명은 오케스트레이션(StopTask)이 관리한다.
 */
export async function startRemoteLoad({ controlUrl, vus }) {
  await post(controlUrl, '/vus', { vus })
  const state = await get(controlUrl, '/state')
  const stats = { requests: 0, errors: 0 }
  return {
    vus: state.vus,
    stats,
    controlUrl,
    async stop() {
      const final = await get(controlUrl, '/state').catch(() => ({ requests: 0, errors: 0 }))
      await post(controlUrl, '/vus', { vus: 0 }).catch(() => {})
      stats.requests = final.requests
      stats.errors = final.errors
      return { ...stats }
    },
  }
}

/**
 * 측정 중 부하가 실제로 유지되고 있는지 확인한다.
 *
 * **이것이 없으면 조용히 망가진다.** 각 행에 기록되는 `vus`는 설정값이지 실측이
 * 아니라서, 부하 태스크가 죽어도 행에는 `vus: 30`이 남고 서버는 놀고 있다. 그 데이터는
 * "부하 30%에서 잰 값"으로 학습에 들어가고, 부하 축 전체가 오염된다. 어느 행이
 * 오염됐는지 사후에 구분할 방법도 없다.
 *
 * **보정하지 않는다.** 어긋나면 기록하고, 계속 어긋나면 멈춘다. 여기서 VU를 조절하면
 * 부하가 측정 대상에 반응하는 제어 루프가 되어 외생성이 깨진다 — 캘리브레이션을
 * 측정 전에 끝내는 이유가 그대로 무너진다.
 */
export function makeLoadVerifier({ base, expectedCpuPct, tolerance = 12, streakLimit = 3, log = console.log }) {
  let streak = 0
  let checks = 0
  return {
    /** 셀 하나를 시작하기 전에 부른다. 오염 시 { ok: false }를 돌려준다. */
    async check() {
      if (expectedCpuPct == null) return { ok: true, cpuPct: null }
      let m
      try {
        await snapshot(base) // 기준점 리셋
        await sleep(2000)
        m = await snapshot(base)
      } catch (err) {
        return { ok: true, cpuPct: null, note: `메트릭 조회 실패(${err.message}) — 판단 보류` }
      }
      checks++
      const off = Math.abs(m.cpuPct - expectedCpuPct)
      if (off <= tolerance) {
        streak = 0
        return { ok: true, cpuPct: m.cpuPct }
      }
      streak++
      log(
        `  부하 이탈 ${streak}/${streakLimit} — 실측 ${m.cpuPct.toFixed(1)}% vs 기대 ` +
          `${expectedCpuPct.toFixed(1)}% (허용 ±${tolerance}%p)`,
      )
      if (streak >= streakLimit) {
        return {
          ok: false,
          cpuPct: m.cpuPct,
          reason:
            `배경 부하가 ${streak}회 연속 기대에서 벗어났다 — 부하 생성기가 죽었을 가능성이 높다. ` +
            '이 상태로 계속 재면 부하 축이 오염된 데이터가 쌓인다.',
        }
      }
      return { ok: true, cpuPct: m.cpuPct, deviating: true }
    },
    stats: () => ({ checks, streak }),
  }
}
