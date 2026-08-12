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

import { searchVus } from '../../load/search.mjs'

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
 * 탐색 알고리즘(지수 탐침 → 이진 탐색 → 지속 확인)은 `load/search.mjs`의 단일
 * 구현을 쓴다 — calibrate.mjs와 복제돼 있다가 수정이 한쪽에만 들어가는 사고가
 * 실제로 났고(c66d7c8), 여기는 원격 측정 함수만 주입한다.
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
}) {
  const result = await searchVus({
    target,
    tolerance,
    maxVus,
    measureAt: (vus) => measureAt({ base, controlUrl, vus, settleMs, observeMs }),
    holdAt: (vus) => measureAt({ base, controlUrl, vus, settleMs: holdSettleMs, observeMs: holdMs }),
    holdRounds,
    log: (m) => console.log(`  캘리브레이션 ${m}`),
  })
  return { ...result, holdMs }
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
export async function resetRemoteLoad(controlUrl) {
  try {
    const before = await get(controlUrl, '/state').catch(() => null)
    if (before && before.vus === 0) return { vus: 0, wasRunning: false }
    if (before) console.log(`  부하 초기화 — 이전 워커가 남긴 VU ${before.vus}를 0으로 되돌린다`)
    await post(controlUrl, '/vus', { vus: 0 })
    // 정리된 요청이 SUT에서 빠져나갈 시간. 이걸 안 주면 첫 탐침이 잔열을 함께 잰다.
    await sleep(5000)
    return { vus: 0, wasRunning: Boolean(before && before.vus > 0) }
  } catch (err) {
    console.log(`  부하 초기화 실패(${err.message}) — 캘리브레이션에서 다시 시도한다`)
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
export function makeLoadVerifier({
  base,
  expectedCpuPct,
  tolerance = 12,
  streakLimit = 3,
  /**
   * **관측창은 기대값을 만든 창과 비교 가능해야 한다.**
   *
   * 2초였다. 그 창의 표본은 ±13%p로 흩어지는데(slice-b2 run2 실측: low 15.0~41.9,
   * mid 51.3~69.6, high 72.5~100.0), 그걸 180초 평균과 ±12%p 허용치로 비교했다.
   * 즉 감시가 부하 이탈이 아니라 자기 표본 잡음을 재고 있었다.
   *
   * 오경보 한 번이 비싸다: 3회 연속이면 샤드가 멈추고, `States.TaskFailed` 재시도를
   * 뺐으므로 Parallel이 실행 전체를 끝낸다. 셀당 300개 검사면 우연한 3연속은
   * 드물지 않다.
   *
   * 15초는 thinkTime(1초)의 15배라 VU 위상이 평균되고, 셀 하나(~3분)에 비하면
   * 5% 비용이다. 캘리브레이션의 버스트 문제와 같은 종류의 오류였다 — 변동하는
   * 양을 너무 짧은 창으로 재고 그 값을 셀 정의로 삼는 것.
   */
  observeMs = 15_000,
}) {
  let streak = 0
  return {
    /** 각 행에 함께 기록해 어느 창으로 잰 값인지 남긴다. 창을 바꾸면 값의 성격이 바뀐다. */
    observeMs,
    /** 셀 하나를 시작하기 전에 부른다. 오염 시 { ok: false }를 돌려준다. */
    async check() {
      if (expectedCpuPct == null) return { ok: true, cpuPct: null }
      let m
      try {
        await snapshot(base) // 기준점 리셋
        await sleep(observeMs)
        m = await snapshot(base)
      } catch (err) {
        return { ok: true, cpuPct: null, note: `메트릭 조회 실패(${err.message}) — 판단 보류` }
      }
      const off = Math.abs(m.cpuPct - expectedCpuPct)
      if (off <= tolerance) {
        streak = 0
        return { ok: true, cpuPct: m.cpuPct }
      }
      streak++
      console.log(
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
  }
}
