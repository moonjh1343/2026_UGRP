import { putBeacon } from '@/lib/instrument/store'

export const dynamic = 'force-dynamic'

/**
 * RUM 수집 엔드포인트. 5단계에서 Kinesis Firehose로 교체되고,
 * 2단계에서는 인메모리 링 버퍼에 적재해 조인 검증만 가능하게 한다.
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  const b = body as Record<string, unknown>
  const cid = typeof b.cid === 'string' ? b.cid : null
  if (!cid) return new Response(null, { status: 400 })

  putBeacon({
    kind: 'beacon',
    cid,
    sid: typeof b.sid === 'string' ? b.sid : null,
    mode: typeof b.mode === 'string' ? b.mode : null,
    routeKey: typeof b.routeKey === 'string' ? b.routeKey : null,
    metrics: (b.metrics ?? {}) as Record<string, number>,
    attribution: (b.attribution ?? {}) as Record<string, unknown>,
    hydrationErrors: typeof b.hydrationErrors === 'number' ? b.hydrationErrors : 0,
    ts: Date.now(),
  })

  // sendBeacon은 응답 본문을 읽지 않는다. 204로 최소 응답.
  return new Response(null, { status: 204 })
}
