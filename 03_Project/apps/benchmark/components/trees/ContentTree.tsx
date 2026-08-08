import { ArticleMeta } from '../leaves/ArticleMeta'
import { Figure } from '../leaves/Figure'
import { SectionBlock } from '../leaves/SectionBlock'
import { WidgetSlot } from '../widgets/WidgetSlot'
import type { ContentPayload } from '@/lib/data'

/**
 * 콘텐츠형 트리. **지시어 없음** — 이것이 5개 모드를 한 벌로 담당하는 핵심이다.
 *
 * RSC에서 'use client' 없는 모듈은 임포트하는 쪽의 그래프를 따른다.
 *   - Islands 모드: 서버 컴포넌트가 임포트 → 서버 그래프 (JS 미전송, 위젯만 섬)
 *   - 그 외 모드:  ContentTree.client.tsx가 임포트 → 클라이언트 그래프 (전체 하이드레이션)
 *
 * 트리를 두 벌 쓰면 측정된 차이가 렌더 방식 때문인지 코드 차이 때문인지
 * 구분할 수 없게 된다(설계 문서 §1).
 */
export function ContentTree({ data }: { data: ContentPayload }) {
  return (
    <article className="content" data-route={data.routeKey}>
      <header>
        <h1>{data.title}</h1>
        <ArticleMeta meta={data.meta} />
        <div className="actions">
          {data.widgets.map((w) => (
            <WidgetSlot key={w.id} widget={w} toc={data.toc} />
          ))}
        </div>
      </header>

      <Figure {...data.hero} />

      {data.sections.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
    </article>
  )
}
