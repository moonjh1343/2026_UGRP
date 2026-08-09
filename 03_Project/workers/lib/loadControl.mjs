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

async function post(controlUrl, path, body) {
  const res = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`부하 제어 ${path} 실패: HTTP ${res.status}`)
  return res.json()
}

async function get(controlUrl, path) {
  const res = await fetch(`${controlUrl}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`부하 제어 ${path} 실패: HTTP ${res.status}`)
  return res.json()
}

/** SUT의 CPU 스냅샷. 조회 사이의 델타를 돌려주므로 첫 조회는 기준점 리셋이다. */
async function snapshot(base) {
  const res = await fetch(`${base}/api/internal/metrics`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`메트릭 조회 실패: HTTP ${res.status}`)
  return res.json()
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
 */
export async function calibrateRemote({
  base,
  controlUrl,
  target,
  tolerance = 4,
  maxVus = 256,
  settleMs = 8000,
  observeMs = 20000,
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
  if (m.cpuPct < target) {
    log(`  경고: VU ${hi}(상한 ${maxVus})에서도 ${m.cpuPct.toFixed(1)}% — 목표 ${target}% 미달`)
    return { vus: hi, cpuPct: m.cpuPct, target, reached: false }
  }

  let best = { vus: hi, cpuPct: m.cpuPct }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await at(mid)
    log(`  캘리브레이션 이분 VU=${mid} cpu=${r.cpuPct.toFixed(1)}%`)
    if (Math.abs(r.cpuPct - target) < Math.abs(best.cpuPct - target)) best = { vus: mid, cpuPct: r.cpuPct }
    if (Math.abs(r.cpuPct - target) <= tolerance) break
    if (r.cpuPct < target) lo = mid
    else hi = mid
  }
  return { ...best, target, reached: Math.abs(best.cpuPct - target) <= tolerance }
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
