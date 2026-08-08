/** 검증 스크립트 공용 유틸. 라우트 테이블은 앱에서 읽어 하드코딩을 피한다. */

export const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

export async function loadRoutes() {
  const res = await fetch(`${BASE}/api/internal/routes`)
  if (!res.ok) throw new Error(`라우트 테이블 조회 실패: HTTP ${res.status}`)
  return res.json()
}

/**
 * 트리가 붙었는지 판정하는 선택자.
 *
 * 모든 트리가 루트 요소에 data-route를 달므로 유형에 무관하게 쓸 수 있다.
 * CSR·Streaming은 스켈레톤을 먼저 그리므로, 이 선택자가 나타나야 "최종 DOM"이다.
 */
export const READY = '#app-root [data-route]'

export function pageUrl(mode, type, key) {
  return `${BASE}/m/${mode}/${type}/${key}`
}

/** 유형별 대표 인스턴스 하나만 고른다 — 중앙값 인스턴스(3번째) */
export function representative(routes, type) {
  const of = routes.filter((r) => r.type === type)
  return of[Math.floor(of.length / 2)] ?? of[0]
}

export function median(xs) {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function pad(s, n) {
  return String(s).padEnd(n)
}

export function num(v, w, d = 1) {
  return (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w)
}
