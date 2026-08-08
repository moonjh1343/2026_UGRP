import { headers } from 'next/headers'
import type { Mode } from '@/lib/modes'
import type { Route } from '@/lib/routes'
import { HEADER } from './correlation'
import { enterRequest, exitRequest } from './serverState'
import { putRender } from './store'

/**
 * 렌더 구간의 CPU 시간을 측정하고 레코드를 남긴다.
 *
 * **오염 주의(설계 문서 §7).** process.cpuUsage()는 프로세스 전체 값이므로,
 * k6 배경 부하가 동시 처리되면 델타에 남의 작업이 섞인다. 부하가 높을수록
 * 오차가 커진다. 따라서 이 값은 Idle 셀의 C_render 측정에만 쓰고,
 * 부하 구간에서는 총 CPU ÷ 처리 요청 수(실효값)를 별도로 사용한다.
 *
 * **측정 범위.** 페이지 함수 실행(데이터 획득 + 트리 구성)까지만 포함한다.
 * React가 HTML로 직렬화하는 비용은 Next 내부에서 일어나 여기에 잡히지 않으므로,
 * 이 값은 렌더 총비용의 하한이다.
 */
export async function recordRender<T>(
  mode: Mode,
  route: Route,
  render: () => Promise<T>,
): Promise<T> {
  // SSG는 요청 전에 렌더되므로 headers()를 쓸 수 없다 — force-static이 깨진다.
  // 요청별 cid가 없는 것이 정상이며, 이 레코드는 "재검증 시점 렌더"를 뜻한다.
  let cid: string | null = null
  let sid: string | null = null
  let policy: string | null = null
  let decisionReason: string | null = null
  let policyUs: number | null = null
  if (mode !== 'ssg') {
    const h = await headers()
    cid = h.get(HEADER.correlationId)
    sid = h.get(HEADER.sessionId)
    policy = h.get(HEADER.policy)
    decisionReason = h.get(HEADER.decisionReason)
    const us = h.get(HEADER.policyUs)
    policyUs = us === null ? null : Number(us)
  }

  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  enterRequest()

  try {
    return await render()
  } finally {
    exitRequest()
    const cpu = process.cpuUsage(cpu0)
    putRender({
      kind: 'render',
      cid,
      sid,
      mode,
      routeType: route.type,
      routeKey: route.key,
      cpuUs: cpu.user + cpu.system,
      wallMs: performance.now() - t0,
      policy,
      decisionReason,
      policyUs,
      ts: Date.now(),
    })
  }
}
