/**
 * 배경 부하 생성기 (로컬).
 *
 * 배포에서는 `background.js`(k6, Fargate Spot)가 이 역할을 한다. 로컬에는 k6 바이너리가
 * 없으므로 같은 라우트 믹스를 그대로 읽는 Node 대체본을 둔다 — **믹스 정의가 갈라지면
 * 로컬에서 캘리브레이션한 VU 수를 배포에 옮길 수 없다.**
 *
 * 부하는 **외생 변수**여야 한다(제안서 §5.2, CLAUDE.md). 즉:
 *   - 부하 자체가 측정 대상 라우트를 건드리면 안 된다(rps_r·캐시 상태가 오염된다)
 *   - 부하 수준은 셀 정의에 고정된 값이어야지, 측정 중에 자동으로 변하면 안 된다
 *     (그래서 배포에서는 오토스케일링을 끄고 desiredCount를 고정한다)
 *   - 측정 요청은 이 부하 **위에 얹혀서** 한 건 나간다
 *
 * 단독 실행:  node generator.mjs --vus 20 --duration 30
 * 모듈 사용:  const load = await startLoad({ vus: 20 }); … ; await load.stop()
 */
import { readFile } from 'node:fs/promises'
import { setMaxListeners } from 'node:events'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

export async function loadProfile() {
  const raw = await readFile(new URL('./profile.json', import.meta.url), 'utf8')
  return JSON.parse(raw)
}

/** 가중치를 펼친 라우트 배열. 매 요청마다 가중 샘플링하는 것보다 싸다. */
function expand(profile) {
  const out = []
  for (const r of profile.routes) {
    const path = profile.path
      .replace('{mode}', profile.mode)
      .replace('{type}', r.type)
      .replace('{key}', r.key)
    for (let i = 0; i < r.weight; i++) out.push(`${BASE}${path}`)
  }
  return out
}

/**
 * VU(가상 사용자) = 동시 요청 스트림 하나. 각 스트림은 응답을 **끝까지 읽고** 다음 요청을
 * 보낸다 — 본문을 버리면 서버가 스트리밍을 중단해 부하가 실제보다 가벼워진다.
 */
export async function startLoad({ vus, profile }) {
  const p = profile ?? (await loadProfile())
  if (vus <= 0) {
    // Idle도 같은 모양을 돌려줘야 호출부가 분기 없이 stats를 읽을 수 있다
    const stats = { requests: 0, errors: 0 }
    return { vus: 0, stats, stop: async () => ({ ...stats }) }
  }

  const urls = expand(p)
  const controller = new AbortController()
  const stats = { requests: 0, errors: 0 }

  /*
   * **경고를 쓸모 있게 유지한다.**
   *
   * 정상 상태에서 abort 리스너 수는 VU 수로 유계다 — 각 VU가 sleep 중일 때 하나씩
   * 갖는다. 기본 임계값 10에서는 VU가 11개만 넘어도 매 실행 경고가 떠서, 그 경고가
   * 진짜 누수를 뜻하는지 아닌지 구별할 수 없다.
   *
   * 그 구별이 실제로 필요했다: slice-b 실패의 원인이 이 시그널의 리스너 누수였고
   * (프로덕션 로그에 8만 개), 경고가 평소에도 뜨는 상태였다면 그냥 잡음으로 넘겼을
   * 것이다. VU 수 + 여유로 올려 두면 **이후에 뜨는 경고는 누수 신호다.**
   */
  setMaxListeners(vus + 10, controller.signal)

  const think = Number(p.thinkTimeMs ?? 0)
  /*
   * **정상 경로에서 리스너를 반드시 해제한다.**
   *
   * `controller.signal`은 실행 전체를 사는 객체다. 해제하지 않으면 sleep 한 번마다
   * 리스너가 하나씩 영구히 쌓이는데, thinkTime 1초 × VU 96이면 초당 ~96개다.
   * 그러면 부하 생성기 자신의 CPU가 리스너 목록 관리에 잡아먹혀 **요청 발행률이
   * 시간이 갈수록 떨어진다** — VU를 고정해 두었는데도 SUT의 CPU가 흘러내린다.
   *
   * 이 누수로 slice-b 첫 수집이 죽었다(2026-08-09). 부하 91.4% → 42.4%로 단조 감소해
   * 워커의 이탈 감시가 3회 연속 초과를 보고 멈췄다. 로그에 리스너 8만 개가 찍혔다.
   *
   * 5단계부터 잠복해 있던 결함이다. 캘리브레이션은 짧은 버스트라 누수가 물리기 전에
   * 끝나고, 로컬 파일럿은 idle 셀만 돌렸다 — 부하 셀을 지속적으로 돌린 것이
   * 그때가 처음이었다.
   */
  const sleep = (ms) =>
    new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })

  const stream = async (id) => {
    let i = id // VU마다 다른 지점에서 시작해 같은 라우트에 동시 몰림을 피한다
    /*
     * VU 시작 시점을 대기 시간 안에서 흩는다. 전부 동시에 출발하면 요청이
     * 파도처럼 몰렸다 비어, 같은 평균 CPU라도 순간 부하가 목표와 달라진다.
     */
    if (think > 0) await sleep((think * id) / Math.max(1, vus))

    while (!controller.signal.aborted) {
      try {
        const res = await fetch(urls[i++ % urls.length], { signal: controller.signal })
        await res.arrayBuffer()
        stats.requests++
      } catch {
        if (controller.signal.aborted) return
        stats.errors++
      }
      // 요청 사이 대기 — 없으면 VU 하나가 코어의 절반을 먹어 부하 조절이 불가능하다
      if (think > 0) await sleep(think)
    }
  }

  const runners = Array.from({ length: vus }, (_, i) => stream(i))

  return {
    vus,
    stats,
    async stop() {
      controller.abort()
      await Promise.allSettled(runners)
      return { ...stats }
    },
  }
}

// --------------------------------------------------------------- 단독 실행

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : Number(process.argv[i + 1])
  }
  const vus = arg('vus', 10)
  const duration = arg('duration', 30)

  const load = await startLoad({ vus })
  console.log(`부하 시작 — VU ${vus}, ${duration}초`)

  const timer = setInterval(async () => {
    try {
      const snap = await (await fetch(`${BASE}/api/internal/metrics`)).json()
      console.log(
        `  cpu=${snap.cpuPct.toFixed(1)}%  루프지연p95=${snap.eventLoopP95Ms.toFixed(1)}ms  ` +
          `inflight=${snap.inflight}  요청=${load.stats.requests}`,
      )
    } catch {
      /* 서버가 잠깐 밀리는 것은 부하 중 정상이다 */
    }
  }, 5000)

  await new Promise((r) => setTimeout(r, duration * 1000))
  clearInterval(timer)
  const final = await load.stop()
  console.log(`부하 종료 — 요청 ${final.requests}건, 오류 ${final.errors}건`)
}
