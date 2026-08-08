/**
 * 라우트 정적 특징 룩업 테이블 (설계 문서 §10).
 *
 * 라우트 특성을 요청마다 계산하면 **그 계산이 곧 오버헤드**이고, 4단계 합격 기준인
 * "추론 오버헤드 < 2ms"를 정책이 아니라 피처 수집이 잡아먹게 된다.
 * 따라서 모듈 초기화 시 한 번만 만들고 이후에는 Map 조회만 한다.
 *
 * 모듈 초기화는 아이솔레이트당 1회이므로 요청 경로에 들어가지 않는다.
 */
import { MODES, type Mode } from '@/lib/modes'
import { ROUTES, ROUTE_TYPES, type Route, type RouteType, candidateModes } from '@/lib/routes'
import bundles from './bundles.generated.json'

export type RouteEntry = {
  route: Route
  candidates: Mode[]
  /** 모드별 클라이언트 JS(KB). analyze:routes 미실행 시 전부 0 */
  bundleKB: Record<Mode, number>
}

/**
 * 번들 크기는 빌드 산출물에서 나오는데 이 파일은 그 빌드에 **포함**된다.
 * 즉 한 빌드 뒤처진 값이 임베드된다(analyze:routes → 재빌드로 확정).
 *
 * 이를 감수하는 이유: 엣지 런타임에는 파일 시스템이 없어 런타임 로드가 불가능하고,
 * 번들 크기는 코드가 바뀌지 않는 한 재빌드해도 그대로다. 코드 변경과 함께
 * 측정할 때만 analyze:routes → build를 한 번 더 돌리면 된다.
 */
const RAW = (bundles as { byModeType?: Record<string, number> }).byModeType ?? {}

function bundleFor(mode: Mode, type: RouteType): number {
  return RAW[`${mode}/${type}`] ?? 0
}

function buildTable(): Map<string, RouteEntry> {
  const table = new Map<string, RouteEntry>()
  for (const route of ROUTES) {
    const bundleKB = {} as Record<Mode, number>
    for (const m of MODES) bundleKB[m] = bundleFor(m, route.type)
    table.set(`${route.type}/${route.key}`, {
      route,
      candidates: candidateModes(route),
      bundleKB,
    })
  }
  return table
}

const TABLE = buildTable()

export function lookup(type: string, key: string): RouteEntry | undefined {
  return TABLE.get(`${type}/${key}`)
}

/**
 * 공개 URL 판정용 유형 집합. 정규식을 요청마다 만들지 않도록 모듈 스코프에 고정한다.
 * `/m/…`(강제 지정 경로), `/api/…`와 겹치지 않아야 한다.
 */
const PUBLIC_PATH = new RegExp(`^/(${ROUTE_TYPES.join('|')})/([^/]+)/?$`)

export function parsePublicPath(pathname: string): { type: RouteType; key: string } | null {
  const m = PUBLIC_PATH.exec(pathname)
  if (!m) return null
  return { type: m[1] as RouteType, key: m[2] }
}

/** 강제 지정 경로 `/m/<mode>/<type>/<key>` — factorial 수집에서 워커가 직접 찍는다. */
const FORCED_PATH = /^\/m\/([^/]+)\/([^/]+)\/([^/]+)/

export function parseForcedPath(
  pathname: string,
): { mode: string; type: string; key: string } | null {
  const m = FORCED_PATH.exec(pathname)
  if (!m) return null
  return { mode: m[1], type: m[2], key: m[3] }
}

export function bundlesGenerated(): boolean {
  return Object.keys(RAW).length > 0
}
