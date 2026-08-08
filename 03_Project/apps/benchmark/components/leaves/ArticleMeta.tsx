import type { ContentPayload } from '@/lib/data'

/** 지시어 없음 — 두 그래프 공용. */
export function ArticleMeta({ meta }: { meta: ContentPayload['meta'] }) {
  return (
    <p className="meta">
      <span className="author">{meta.author}</span>
      <time dateTime={meta.publishedAt}>{meta.publishedAt}</time>
      <span className="reading">{meta.readingMinutes}분</span>
    </p>
  )
}
