/**
 * 세션 단위 결정 캐시 — 모드 전환 상한 강제 (제안서 §3.5).
 *
 * 왜 필요한가: 같은 세션에서 모드가 오락가락하면 사용자는 매번 다른 로딩 경험을
 * 겪고, 캐시도 모드마다 갈라져 두 번 데운다. 예측 이득이 그 비용을 넘지 못한다.
 *
 * 왜 쿠키인가: 엣지 아이솔레이트는 요청 간 상태를 공유하지 않고, DynamoDB 왕복은
 * TTFB에 얹힌다. 결정 상태는 클라이언트가 들고 다니는 것이 가장 싸다.
 *
 * 인코딩은 `key:mode:n|key:mode:n`. JSON.parse보다 싸고, 쿠키 크기도 작다.
 */
import type { Mode } from '@/lib/modes'
import { SESSION_DECISION_SLOTS } from './config'

export type SessionDecision = { mode: Mode; switches: number }

export function readDecisions(raw: string | undefined): Map<string, SessionDecision> {
  const out = new Map<string, SessionDecision>()
  if (!raw) return out
  for (const part of raw.split('|')) {
    const [key, mode, n] = part.split(':')
    if (!key || !mode) continue
    out.set(key, { mode: mode as Mode, switches: Number(n) || 0 })
  }
  return out
}

export function writeDecisions(map: Map<string, SessionDecision>): string {
  // 오래된 항목부터 버린다 — Map은 삽입 순서를 보존하므로 재삽입이 곧 최신화다.
  const entries = [...map.entries()].slice(-SESSION_DECISION_SLOTS)
  return entries.map(([k, v]) => `${k}:${v.mode}:${v.switches}`).join('|')
}

export function touch(
  map: Map<string, SessionDecision>,
  key: string,
  value: SessionDecision,
): Map<string, SessionDecision> {
  map.delete(key)
  map.set(key, value)
  return map
}
