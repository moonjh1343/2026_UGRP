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

export type ContentPayload = {
  routeType: 'content'
  routeKey: string
  title: string
  meta: {
    author: string
    /** 결정적 값. Date.now() 대신 시드에서 유도한다 */
    publishedAt: string
    readingMinutes: number
  }
  hero: { src: string; width: number; height: number; alt: string }
  toc: { id: string; label: string }[]
  sections: SectionSpec[]
  widgets: WidgetSpec[]
}

export type Payload = ContentPayload
