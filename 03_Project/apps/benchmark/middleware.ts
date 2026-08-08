import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { COOKIE, HEADER, TIMING, newId, timingEntry } from '@/lib/instrument/correlation'
import {
  collect,
  decide,
  lookup,
  parseForcedPath,
  parsePublicPath,
  readDecisions,
  scheduleRefresh,
  writeDecisions,
} from '@/policy'

/**
 * 결정 계층.
 *
 * 미들웨어가 이 역할을 맡는 이유는 두 가지다.
 *  1. SSG·ISR 요청은 앱 코드가 실행되지 않지만 미들웨어는 **모든 요청에서** 실행된다.
 *     5개 모드에 걸쳐 상관 ID를 균일하게 발급할 수 있는 유일한 지점이다.
 *  2. 모드 선택은 라우팅보다 **먼저** 일어나야 한다. 페이지 안에서 분기하는 방식은
 *     SSG에서 성립하지 않는다(설계 문서 §2).
 *
 * 실배포에서는 이 함수가 Lambda@Edge가 되고, `@/policy`가 그대로 옮겨간다.
 * 그래서 정책 코드에는 Node 전용 API가 없다.
 */
export function middleware(req: NextRequest, event: NextFetchEvent) {
  /*
   * 이미 상관 ID가 실려 있으면 존중한다.
   *
   * CSR의 /api/data 요청은 클라이언트가 페이지의 cid를 전파해 보낸다. 여기서
   * 새 ID를 발급하면 한 페이지뷰의 서버 비용이 두 cid로 흩어져 조인이 끊긴다.
   * 실배포에서도 엣지는 기존 추적 ID를 이어받는 것이 정상 동작이다.
   */
  const cid = req.headers.get(HEADER.correlationId) ?? newId()
  const existingSid = req.cookies.get(COOKIE.sessionId)?.value
  const sid = existingSid ?? newId()

  const pathname = req.nextUrl.pathname
  const forced = parseForcedPath(pathname)
  const publicPath = parsePublicPath(pathname)

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(HEADER.correlationId, cid)
  requestHeaders.set(HEADER.sessionId, sid)

  const timings: string[] = []

  if (publicPath) {
    const entry = lookup(publicPath.type, publicPath.key)
    if (!entry) return NextResponse.next({ request: { headers: requestHeaders } })

    /*
     * 서버 상태 갱신은 요청을 막지 않는다. waitUntil로 넘겨야 응답 반환 후에도
     * 살아남는다 — 부유 Promise로 두면 취소되어 캐시가 영영 비고 서버 상태
     * 피처가 전부 0으로 굳는다.
     */
    const refresh = scheduleRefresh(req.nextUrl.origin)
    if (refresh) event.waitUntil(refresh)

    const session = readDecisions(req.cookies.get(COOKIE.decision)?.value)
    const features = collect(req, entry)
    const d = decide({
      entry,
      features,
      policyName: req.headers.get(HEADER.policy),
      forcedMode: req.headers.get(HEADER.forceMode),
      session,
    })

    // 앱이 레코드에 남길 수 있도록 결정 결과를 요청 헤더로 넘긴다.
    requestHeaders.set(HEADER.modeApplied, d.mode)
    requestHeaders.set(HEADER.policy, d.policy)
    requestHeaders.set(HEADER.decisionReason, d.reason)
    requestHeaders.set(HEADER.policyUs, d.inferenceUs.toFixed(1))

    const url = req.nextUrl.clone()
    url.pathname = `/m/${d.mode}/${entry.route.type}/${entry.route.key}`

    timings.push(
      timingEntry(TIMING.policy, d.reason, d.inferenceUs / 1000),
      timingEntry(TIMING.mode, d.mode),
      timingEntry(TIMING.route, entry.route.key),
    )

    const res = NextResponse.rewrite(url, { request: { headers: requestHeaders } })
    res.headers.set(HEADER.modeApplied, d.mode)
    res.headers.set(HEADER.policy, d.policy)
    res.headers.set(HEADER.decisionReason, d.reason)
    res.headers.set(HEADER.policyUs, d.inferenceUs.toFixed(1))
    if (d.margin !== null && Number.isFinite(d.margin)) {
      res.headers.set(HEADER.decisionMargin, d.margin.toFixed(4))
    }
    return finish(res, {
      cid,
      sid,
      existingSid,
      decisionCookie: writeDecisions(session),
      timings,
    })
  }

  /*
   * `/m/…` 직접 요청은 정책을 태우지 않는다.
   *
   * factorial 수집은 동일 조건에서 5개 모드를 전부 찍어야 하므로 워커가 경로를
   * 직접 지정하고, 그 경로에서 정책을 돌리는 것은 순수한 낭비다. 8,800셀 × 30회에
   * 불필요한 추론이 얹히면 그 자체가 서버 부하 피처를 오염시킨다.
   */
  const res = NextResponse.next({ request: { headers: requestHeaders } })
  if (forced) {
    timings.push(timingEntry(TIMING.mode, forced.mode), timingEntry(TIMING.route, forced.key))
    res.headers.set(HEADER.modeApplied, forced.mode)
    res.headers.set(HEADER.decisionReason, 'forced')
  }
  return finish(res, { cid, sid, existingSid, decisionCookie: null, timings })
}

type Common = {
  cid: string
  sid: string
  existingSid: string | undefined
  decisionCookie: string | null
  timings: string[]
}

function finish(res: NextResponse, c: Common): NextResponse {
  res.headers.set(HEADER.correlationId, c.cid)
  res.headers.set(HEADER.sessionId, c.sid)

  /*
   * Server-Timing — 브라우저 JS가 읽는 유일한 경로.
   *
   * SSG는 HTML이 요청 전에 확정되므로 본문에 cid를 심을 수 없다. 응답 헤더는
   * 캐시 히트에도 요청마다 새로 붙으므로 5개 모드에서 균일하게 동작한다.
   */
  res.headers.append('Server-Timing', timingEntry(TIMING.correlationId, c.cid))
  res.headers.append('Server-Timing', timingEntry(TIMING.sessionId, c.sid))
  for (const t of c.timings) res.headers.append('Server-Timing', t)

  /*
   * Client Hints 요청. 첫 요청에는 기기·네트워크 힌트가 없고(콜드 스타트),
   * 이 헤더를 받은 다음 요청부터 붙는다. 랩 측정에서는 CDP 스로틀링이 이 값을
   * 바꾸지 않으므로 워커가 x-cell-* 헤더로 진짜 조건을 주입한다.
   */
  res.headers.set('Accept-CH', 'Sec-CH-Device-Memory, Downlink, RTT, ECT, Save-Data')

  if (!c.existingSid) {
    res.cookies.set(COOKIE.sessionId, c.sid, {
      path: '/',
      sameSite: 'lax',
      httpOnly: false, // 세션 프로파일 갱신을 위해 클라이언트에서도 읽는다
      maxAge: 60 * 30,
    })
  }
  if (c.decisionCookie !== null) {
    res.cookies.set(COOKIE.decision, c.decisionCookie, {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      maxAge: 60 * 30,
    })
  }
  return res
}

export const config = {
  /*
   * 정적 자산은 제외한다. 측정 대상은 문서 요청과 API뿐이고,
   * 청크마다 미들웨어를 돌리면 그 오버헤드가 측정에 섞인다.
   */
  matcher: ['/((?!_next/static|_next/image|assets|favicon.ico).*)'],
}
