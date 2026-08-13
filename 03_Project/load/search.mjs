/**
 * VU 탐색 알고리즘 — 로컬(calibrate.mjs)과 원격(workers/lib/loadControl.mjs)이
 * 공유하는 단일 구현.
 *
 * 왜 한 곳인가: 이 알고리즘은 두 곳에 복제돼 있었고, 버스트→지속 2단계 수정
 * (c66d7c8)이 원격에만 들어가 로컬은 버스트 전용으로 남는 사고가 실제로 났다.
 * 측정 함수(로컬은 프로세스 안 startLoad, 원격은 HTTP 제어)만 호출자가 주입하고
 * 탐색 자체는 여기 한 벌만 둔다 — 같은 사고는 구조적으로 재발할 수 없다.
 *
 * 알고리즘 (셀 정의에 고정될 VU를 찾는다):
 *
 *   1. 지수 탐침 — 상한을 두 배씩 넓히되 **상한에서 한 번은 반드시 잰다.**
 *      `while (hi <= max)`로 두면 hi가 상한을 넘는 순간 빠져나가면서 더 낮은
 *      VU의 값을 상한의 값인 것처럼 보고한다(실측: "VU 96에서도 81.5%"라고
 *      출력했는데 96은 잰 적조차 없었다).
 *   2. 이진 탐색 — 목표에 가장 가까운 VU를 찾는다. CPU는 VU에 대해 단조
 *      증가한다는 가정 위에 있으므로, 측정은 반드시 관측 구간 전체를 한 번의
 *      델타로 재야 한다(1초 델타 중앙값은 단조가 아니다 — measureAt 구현 쪽 주석).
 *   3. 지속 확인 — 짧은 버스트로 잰 VU→CPU 대응은 지속 상태에서 성립하지
 *      않는다. 고정 VU는 동시성을 고정할 뿐이고, 닫힌 루프에서 처리율 =
 *      동시성 / (thinkTime + 응답시간)이라 서버가 포화에 가까워지면 응답시간이
 *      늘어 CPU가 내려앉는다(slice-b2 실측: 세 수준 모두 12~16%p 하락). 고른
 *      VU를 몇 분 유지해 평형 CPU를 재고, 벗어나면 감쇠 비례 보정으로 다시
 *      유지한다. **기록에 남는 cpuPct는 지속값이다** — 이탈 감시가 측정 중에
 *      비교하는 값이 바로 이것이어야 한다.
 *
 * 이것은 측정 중 제어 루프가 아니다. 전부 측정 시작 전에 끝나고 그 뒤 VU는
 * 얼린다 — 부하가 측정 대상에 반응하면 외생성이 깨진다.
 *
 * @param opts.measureAt async (vus) => { cpuPct, ... } — 버스트 관측 (탐침·이분용)
 * @param opts.holdAt    async (vus) => { cpuPct, ... } — 지속 관측 (평형 확인용)
 * @param opts.floor     탐색 시작 VU. 낮은 수준의 확정 VU가 다음 수준의 하한이 된다
 * @param opts.log       (message: string) => void — 호출자가 접두어를 붙인다
 */
export async function searchVus({
  target,
  tolerance = 4,
  /*
   * 512다 — 상한은 "더 밀면 CPU가 오르는가"가 아니라 "SUT가 관측 가능한 채로
   * 남는가"로 정한다. 실험 하드웨어(Fargate 2 vCPU, 로컬 --cpus 2 재현 동일)의
   * 실측 곡선: VU 256→57~64%, 512→66~71%, 1024→62%(라우트별 RPS가 512와 동일 —
   * 처리율 포화, 추가 VU는 큐잉만), 2048→/api/internal/metrics 타임아웃으로
   * 캘리브레이션 자체가 죽는다(grid-v1 5차 실행 사망 원인). 한때 2048이었던
   * 근거(2026-08-12, 18코어 호스트에서 512→85%·1024→97%)는 호스트 코어가
   * 남아돌던 측정이라 이 태스크 크기에서는 성립하지 않는다.
   */
  maxVus = 512,
  floor = 1,
  measureAt,
  holdAt,
  holdRounds = 4,
  dampening = 0.7,
  log = () => {},
}) {
  if (target <= 0) return { vus: 0, cpuPct: 0, target, reached: true, burst: { vus: 0, cpuPct: 0 }, holdRounds: 0 }

  // ── 1. 지수 탐침 ─────────────────────────────────────────────────────────
  let lo = Math.max(1, floor)
  let hi = lo
  let hiCpu = 0
  while (true) {
    const m = await measureAt(hi)
    log(`탐침 VU=${String(hi).padStart(3)} cpu=${m.cpuPct.toFixed(1)}%`)
    hiCpu = m.cpuPct
    if (m.cpuPct >= target) break
    if (hi >= maxVus) break
    lo = hi
    hi = Math.min(maxVus, hi * 2)
  }

  let burst = { vus: hi, cpuPct: hiCpu }
  if (hiCpu < target) {
    log(`경고: VU ${hi}(상한 ${maxVus})에서도 버스트 ${hiCpu.toFixed(1)}% — 목표 ${target}% 미달`)
  } else {
    // ── 2. 이진 탐색 ───────────────────────────────────────────────────────
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const m = await measureAt(mid)
      log(`이분 VU=${String(mid).padStart(3)} cpu=${m.cpuPct.toFixed(1)}%`)
      if (Math.abs(m.cpuPct - target) < Math.abs(burst.cpuPct - target)) burst = { vus: mid, cpuPct: m.cpuPct }
      if (Math.abs(m.cpuPct - target) <= tolerance) break
      if (m.cpuPct < target) lo = mid
      else hi = mid
    }
  }

  // ── 3. 지속 확인 + 감쇠 비례 보정 ────────────────────────────────────────
  let vus = burst.vus
  let best = null
  let round = 0
  while (round < Math.max(1, holdRounds)) {
    round++
    const h = await holdAt(vus)
    log(
      `지속 확인 ${round}/${holdRounds} VU=${String(vus).padStart(3)} cpu=${h.cpuPct.toFixed(1)}% ` +
        `(목표 ${target}% · 버스트 ${burst.cpuPct.toFixed(1)}%)`,
    )
    if (best === null || Math.abs(h.cpuPct - target) < Math.abs(best.cpuPct - target)) best = { ...h, vus }
    if (Math.abs(h.cpuPct - target) <= tolerance) break

    // 포화 근처에서 VU→CPU 기울기가 완만해지므로 순수 비례(target/cpu)로 밀면
    // 넘겨 짚고 진동한다 — 감쇠를 건다.
    const scale = h.cpuPct > 0 ? target / h.cpuPct : 2
    const next = Math.max(1, Math.min(maxVus, Math.round(vus * (1 + (scale - 1) * dampening))))
    if (next === vus) {
      log(`지속 확인 — VU ${vus}에서 보정할 여지가 없다 (상한 ${maxVus})`)
      break
    }
    vus = next
  }

  const reached = Math.abs(best.cpuPct - target) <= tolerance
  if (!reached) {
    log(`경고: 지속 상태 ${best.cpuPct.toFixed(1)}% — 목표 ${target}%에 ${holdRounds}회 안에 못 맞췄다`)
  }
  /*
   * cpuPct는 지속값. 버스트값도 남긴다 — 둘의 차이가 이 하드웨어에서 닫힌 루프가
   * 얼마나 물러나는지의 기록이고, 사후에 부하 축을 해석할 때 쓴다.
   */
  return { ...best, target, reached, holdRounds: round, burst: { ...burst } }
}
