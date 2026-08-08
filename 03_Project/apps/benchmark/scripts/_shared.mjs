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

/**
 * #app-root 하위의 정규 직렬화. page.evaluate에 넘겨 쓴다.
 *
 * innerHTML을 그대로 비교하면 안 되는 이유: innerHTML은 **속성의 삽입 순서**를
 * 보존하는데, 서버에서 파싱된 HTML과 클라이언트에서 createElement로 만든 요소는
 * 그 순서가 다르다(SSR `<img src=… width=…>`, CSR `<img width=… src=…>`).
 * DOM 명세상 속성은 순서 없는 맵이므로 이는 실제 차이가 아니다.
 *
 * 아래는 모드마다 다른 것이 **정상**이므로 제외한다.
 *   - 주석 노드: Streaming SSR의 Suspense 경계 마커(<!--$-->)
 *   - script/template/style/link: RSC flight data, 부트스트랩 페이로드
 *   - #app-root 자신의 속성: data-mode가 모드마다 다름 → 자식만 비교
 *   - 공백 전용 텍스트 노드
 *
 * 1단계(check:dom)와 4단계(check:policy)가 **같은 정규형**을 써야 한다.
 * 갈라지면 한쪽만 통과하는 상태가 조용히 생긴다.
 */
export const EXTRACT = () => {
  const root = document.querySelector('#app-root')
  if (!root) return null

  const SKIP = new Set(['script', 'template', 'style', 'link'])
  /*
   * 폼 컨트롤은 **속성이 아니라 라이브 프로퍼티**로 비교한다.
   *
   * React는 서버 렌더 시 <option selected=""> 속성을 붙이고, 클라이언트 렌더 시에는
   * select의 value 프로퍼티를 설정한다. 선택 상태는 같은데 직렬화만 다르다.
   * 속성을 지우고 현재 value/checked를 기록하면 구성 방식이 아니라 **상태**를 비교하게 되어
   * 오히려 더 강한 검사가 된다.
   */
  const LIVE_VALUE = new Set(['input', 'select', 'textarea'])
  const DROP_ATTR = new Set(['selected', 'checked', 'value'])
  const out = []

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue.replace(/\s+/g, ' ')
      if (t.trim()) out.push(t)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const tag = node.tagName.toLowerCase()
    if (SKIP.has(tag)) return

    const isControl = LIVE_VALUE.has(tag)
    const attrs = Array.from(node.attributes)
      .filter((a) => !((isControl || tag === 'option') && DROP_ATTR.has(a.name)))
      .map((a) => `${a.name}="${a.value}"`)

    if (isControl) {
      attrs.push(`data-live-value="${node.value ?? ''}"`)
      if (tag === 'input') attrs.push(`data-live-checked="${node.checked ? '1' : '0'}"`)
    }

    out.push(`<${tag}${attrs.length ? ' ' + attrs.sort().join(' ') : ''}>`)
    for (const c of node.childNodes) walk(c)
    out.push(`</${tag}>`)
  }

  for (const c of root.childNodes) walk(c)
  return out.join('')
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
