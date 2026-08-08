import type { RouteType } from '../routes'

export type WidgetSpec = {
  id: string
  kind: 'toc' | 'share' | 'note'
  label: string
}

export type SectionSpec = {
  id: string
  heading: string
  paragraphs: string[]
}

export type BasePayload = {
  routeType: RouteType
  routeKey: string
  title: string
}

/** 콘텐츠형 — 전송 바이트가 지배 */
export type ContentPayload = BasePayload & {
  routeType: 'content'
  meta: { author: string; publishedAt: string; readingMinutes: number }
  hero: { src: string; width: number; height: number; alt: string }
  toc: { id: string; label: string }[]
  sections: SectionSpec[]
  widgets: WidgetSpec[]
}

/** 목록형 — DOM 노드 수가 지배 */
export type ListItem = {
  id: string
  title: string
  summary: string
  price: number
  rating: number
  tags: string[]
  /** 개인화 영역 — ISR로 공용만 캐시하고 이 부분만 클라이언트가 채우는 하이브리드 */
  badge: string | null
}

export type ListPayload = BasePayload & {
  routeType: 'list'
  facets: { id: string; label: string; options: string[] }[]
  items: ListItem[]
  totalCount: number
}

/** 대시보드형 — 하이드레이션 CPU가 지배 */
export type Series = {
  id: string
  label: string
  unit: string
  /** 차트 위젯이 하이드레이션 시점에 스케일·경로를 계산한다 */
  points: number[]
}

export type DashboardPayload = BasePayload & {
  routeType: 'dashboard'
  kpis: { id: string; label: string; value: number; delta: number; unit: string }[]
  charts: Series[]
  filters: { id: string; label: string; options: string[] }[]
  table: { columns: string[]; rows: (string | number)[][] }
}

/** 폼형 — 인터랙션 준비(INP)가 지배 */
export type FieldSpec = {
  id: string
  label: string
  kind: 'text' | 'email' | 'tel' | 'number' | 'select' | 'textarea'
  required: boolean
  /** 클라이언트 검증기가 이 패턴으로 매 입력마다 판정한다 */
  pattern: string | null
  options: string[]
  help: string
  maxLength: number
}

export type FormPayload = BasePayload & {
  routeType: 'form'
  sections: { id: string; heading: string; fields: FieldSpec[] }[]
}

/** 개인화형 — 캐시 불가 + 서버 부하 민감 */
export type PersonalizedPayload = BasePayload & {
  routeType: 'personalized'
  /** 캐시 가능 영역 */
  shared: { heading: string; blurbs: string[] }
  /** 캐시 불가 영역 — SSG 후보에서 배제되는 이유 */
  personalized: {
    greeting: string
    recommendations: { id: string; title: string; score: number }[]
    activity: { id: string; label: string; at: string }[]
  }
}

export type Payload =
  | ContentPayload
  | ListPayload
  | DashboardPayload
  | FormPayload
  | PersonalizedPayload
