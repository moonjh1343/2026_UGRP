import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE, HEADER, TIMING, newId, timingEntry } from '@/lib/instrument/correlation'

/**
 * 결정 계층 대역. 2단계에서는 정책 추론 없이 **상관 ID 발급과 세션 유지**만 한다.
 * 정책 플러그인과 피처 수집은 4단계에서 여기에 붙는다.
 *
 * 미들웨어가 이 역할을 맡는 이유: SSG·ISR 요청은 앱 코드가 실행되지 않지만
 * 미들웨어는 **모든 요청에서** 실행된다. 따라서 5개 모드에 걸쳐 상관 ID를
 * 균일하게 발급할 수 있는 유일한 지점이다.
 */
export function middleware(req: NextRequest) {
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

  const { mode, routeKey } = parseModePath(req.nextUrl.pathname)

  // 앱(서버 컴포넌트·라우트 핸들러)이 읽을 수 있도록 요청 헤더에 실어 보낸다.
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(HEADER.correlationId, cid)
  requestHeaders.set(HEADER.sessionId, sid)

  const res = NextResponse.next({ request: { headers: requestHeaders } })

  // 응답 헤더 — 측정 워커가 읽는다.
  res.headers.set(HEADER.correlationId, cid)
  res.headers.set(HEADER.sessionId, sid)

  /*
   * Server-Timing — 브라우저 JS가 읽는 유일한 경로.
   *
   * SSG는 HTML이 요청 전에 확정되므로 본문에 cid를 심을 수 없다. 응답 헤더는
   * 캐시 히트에도 요청마다 새로 붙으므로 5개 모드에서 균일하게 동작한다.
   */
  res.headers.append('Server-Timing', timingEntry(TIMING.correlationId, cid))
  res.headers.append('Server-Timing', timingEntry(TIMING.sessionId, sid))
  if (mode) res.headers.append('Server-Timing', timingEntry(TIMING.mode, mode))
  if (routeKey) res.headers.append('Server-Timing', timingEntry(TIMING.route, routeKey))

  if (!existingSid) {
    res.cookies.set(COOKIE.sessionId, sid, {
      path: '/',
      sameSite: 'lax',
      httpOnly: false, // 세션 프로파일 갱신을 위해 클라이언트에서도 읽는다
      maxAge: 60 * 30,
    })
  }

  return res
}

function parseModePath(pathname: string): { mode?: string; routeKey?: string } {
  // /m/<mode>/<type>/<key>
  const m = pathname.match(/^\/m\/([^/]+)\/([^/]+)\/([^/]+)/)
  if (!m) return {}
  return { mode: m[1], routeKey: m[3] }
}

export const config = {
  /*
   * 정적 자산은 제외한다. 측정 대상은 문서 요청과 API뿐이고,
   * 청크마다 미들웨어를 돌리면 그 오버헤드가 측정에 섞인다.
   */
  matcher: ['/((?!_next/static|_next/image|assets|favicon.ico).*)'],
}
