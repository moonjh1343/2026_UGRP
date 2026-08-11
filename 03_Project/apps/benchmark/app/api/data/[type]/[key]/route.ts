import { getData } from '@/lib/data'
import { HEADER } from '@/lib/instrument/correlation'
import { enterRequest, exitRequest } from '@/lib/instrument/serverState'
import { noteResponse, putRender } from '@/lib/instrument/store'
import { resolveRoute } from '@/lib/routes'

export const dynamic = 'force-dynamic'

/**
 * CSR 전용 전송로. getData()는 SSR·SSG·Islands가 서버에서 직접 호출하는 것과
 * **동일한 함수**이고, 여기는 HTTP 껍데기만 씌운다.
 * 두 경로가 다른 코드를 타면 페이로드가 갈라져 비교가 오염된다.
 *
 * 상관 ID는 클라이언트가 페이지의 cid를 전파해 준 값을 우선 사용한다.
 * 미들웨어가 이 요청에 발급한 cid를 쓰면 한 페이지뷰의 서버 비용이
 * 두 개로 흩어져 조인이 끊긴다(components/shell/ClientRoot.tsx).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ type: string; key: string }> },
) {
  const { type, key } = await params
  const route = resolveRoute(type, key)

  if (!route) {
    return Response.json({ error: `알 수 없는 라우트: ${type}/${key}` }, { status: 404 })
  }

  const cid = req.headers.get(HEADER.correlationId)
  const sid = req.headers.get(HEADER.sessionId)

  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  enterRequest()

  let failed = false
  try {
    const payload = await getData(route)
    return Response.json(payload)
  } catch (err) {
    failed = true
    throw err
  } finally {
    exitRequest()
    noteResponse(failed ? 500 : 200)
    const cpu = process.cpuUsage(cpu0)
    putRender({
      kind: 'render',
      cid,
      sid,
      mode: 'csr',
      routeType: route.type,
      routeKey: route.key,
      cpuUs: cpu.user + cpu.system,
      wallMs: performance.now() - t0,
      /*
       * 데이터 요청은 결정을 거치지 않는다 — 모드는 이미 페이지 요청에서 정해졌고,
       * 이 왕복은 그 결정의 **결과**다. 같은 cid의 페이지 레코드가 결정을 들고 있다.
       */
      policy: null,
      decisionReason: null,
      policyUs: null,
      decisionMargin: null,
      propensity: null,
      ts: Date.now(),
      /*
       * 라우트 히트로 세지 않는다 — CSR 페이지뷰는 셸 렌더가 이미 셌다.
       * 둘 다 세면 CSR 조건에서만 routeRps가 2배가 되어 서버 상태 피처에
       * 모드가 새어 들어간다.
       */
    }, { countRouteHit: false })
  }
}
