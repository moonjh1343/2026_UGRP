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

  const think = Number(p.thinkTimeMs ?? 0)
  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      controller.signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
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
