/**
 * 부하 생성기 제어 서버.
 *
 * 로컬에서는 run.mjs가 `startLoad()`를 프로세스 안에서 부른다. AWS에서는 그럴 수
 * 없다 — 부하 생성기와 측정 워커는 서로 다른 태스크·서브넷·보안 그룹에 있어야
 * 한다(제안서 §5.3). 한 태스크에 같이 두면 부하 생성이 브라우저와 CPU·네트워크를
 * 다투고, 그러면 측정하는 것이 SUT의 부하인지 워커의 혼잡인지 갈라지지 않는다.
 *
 * 그래서 부하 생성기는 이 얇은 HTTP 껍데기를 쓰고, **캘리브레이션은 워커가 주도한다.**
 * 워커는 이미 SUT의 `/api/internal/metrics`를 읽을 수 있으므로, "VU를 N으로 놓고
 * CPU를 본다"는 이진 탐색이 워커 쪽에서 그대로 성립한다. DynamoDB로 값을 주고받거나
 * 별도 캘리브레이션 태스크를 띄울 이유가 없다.
 *
 * **이 서버는 스스로 VU를 조절하지 않는다.** 목표 CPU를 받아 스스로 맞추는 제어기를
 * 넣고 싶어지지만, 그러면 부하가 측정 요청에 반응하게 되어 외생성이 깨진다
 * (calibrate.mjs의 첫 주석과 같은 이유). 여기는 "시키는 VU 수를 유지한다"만 한다.
 *
 * 사용: node control.mjs [--port 4000]
 */
import { createServer } from 'node:http'
import { loadProfile, startLoad } from './generator.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const PORT = Number(arg('port', process.env.CONTROL_PORT ?? 4000))
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

const profile = await loadProfile()

/** 현재 돌고 있는 부하. 시작할 때는 0 VU — 워커가 지시하기 전에는 아무것도 하지 않는다. */
let current = await startLoad({ vus: 0, profile })
let currentVus = 0
/** 누적 통계. setVus로 갈아탈 때마다 이전 핸들의 stats를 여기에 합친다. */
const totals = { requests: 0, errors: 0 }

async function setVus(n) {
  const next = Math.max(0, Math.floor(n))
  if (next === currentVus) return { vus: currentVus, changed: false }

  const prev = await current.stop()
  totals.requests += prev.requests
  totals.errors += prev.errors

  current = await startLoad({ vus: next, profile })
  currentVus = next
  return { vus: currentVus, changed: true }
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, {
        vus: currentVus,
        base: BASE,
        profileMode: profile.mode,
        requests: totals.requests + current.stats.requests,
        errors: totals.errors + current.stats.errors,
      })
    }

    if (req.method === 'POST' && url.pathname === '/vus') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (typeof body.vus !== 'number' || !Number.isFinite(body.vus) || body.vus < 0) {
        return json(res, 400, { error: 'vus는 0 이상의 유한한 수여야 한다' })
      }
      const out = await setVus(body.vus)
      return json(res, 200, out)
    }

    return json(res, 404, { error: `${req.method} ${url.pathname}` })
  } catch (err) {
    return json(res, 500, { error: err.message })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`부하 제어 서버 — 포트 ${PORT} · 대상 ${BASE} · 현재 VU ${currentVus}`)
})

/*
 * 태스크가 멈출 때 부하도 함께 멈춘다. StopTask는 SIGTERM을 보내므로, 여기서
 * 받아두지 않으면 진행 중인 요청이 끊긴 채로 죽고 SUT 쪽 로그에 오류가 남는다.
 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`${sig} — 부하 중단`)
    await current.stop().catch(() => {})
    server.close(() => process.exit(0))
  })
}
