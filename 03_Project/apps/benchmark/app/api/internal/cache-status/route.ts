import { noteCacheStatus } from '@/lib/instrument/store'

export const dynamic = 'force-dynamic'

/**
 * 캐시 판정 보고. **관측자만 이 값을 볼 수 있다.**
 *
 * `x-nextjs-cache`는 Next이 응답에 붙이는데, 미들웨어는 응답보다 먼저 실행되어 읽을 수 없고
 * 브라우저 JS에는 응답 헤더가 노출되지 않는다. 워커(full header access)가 되돌려 보내야
 * §3.1.2의 missRate를 서버 측 피처(`cacheHitRate`)로 집계할 수 있다.
 *
 * `/api/beacon`에 실어 보내지 않는 이유: 그러면 같은 cid로 비콘 레코드가 두 건 생기고,
 * cid로 조인하는 쪽(`check:join`)이 지표 없는 쪽을 집어 결측으로 판정한다.
 * 조인 키를 공유하는 서로 다른 종류의 레코드는 경로를 나눠야 한다.
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  const status = (body as { cacheStatus?: unknown }).cacheStatus
  if (typeof status !== 'string') return new Response(null, { status: 400 })

  noteCacheStatus(status)
  return new Response(null, { status: 204 })
}
