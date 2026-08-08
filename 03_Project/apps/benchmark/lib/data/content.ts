import { seeded } from '../rng'
import type { Route } from '../routes'
import { AUTHORS, HEADINGS, WORDS } from './lexicon'
import { clamp, seededDate, sentence, wordsPerUnit } from './shared'
import type { ContentPayload, SectionSpec, WidgetSpec } from './types'

/** 섹션 하나가 차지하는 대략적인 DOM 노드 수 — nodeCount에서 섹션 수를 역산한다 */
const NODES_PER_SECTION = 220
const PARAGRAPHS_PER_SECTION = 3

export function generateContent(route: Route): ContentPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  const sectionCount = clamp(Math.round(route.nodeCount / NODES_PER_SECTION), 3, 40)
  const totalParagraphs = sectionCount * PARAGRAPHS_PER_SECTION
  const words = wordsPerUnit(route.payloadKB, totalParagraphs)

  const sections: SectionSpec[] = Array.from({ length: sectionCount }, (_, i) => ({
    id: `sec-${String(i + 1).padStart(2, '0')}`,
    heading: `${i + 1}. ${rng.pick(HEADINGS)}`,
    paragraphs: Array.from({ length: PARAGRAPHS_PER_SECTION }, () =>
      sentence(rng, words, WORDS),
    ),
  }))

  const widgets: WidgetSpec[] = Array.from({ length: route.interactiveCount }, (_, i) => {
    const kind: WidgetSpec['kind'] = i === 0 ? 'toc' : i === 1 ? 'share' : 'note'
    return { id: `w-${i + 1}`, kind, label: WIDGET_LABEL[kind] }
  })

  return {
    routeType: 'content',
    routeKey: route.key,
    title: `${rng.pick(HEADINGS)} — ${route.key}`,
    meta: {
      author: rng.pick(AUTHORS),
      publishedAt: seededDate(rng),
      readingMinutes: Math.max(1, Math.round((totalParagraphs * words) / 300)),
    },
    hero: {
      // 크기가 고정된 로컬 에셋만 쓴다. 외부 CDN·랜덤 플레이스홀더는
      // 페이로드 크기와 지연을 흔들어 노이즈가 된다.
      src: '/assets/hero.svg',
      width: 1200,
      height: 630,
      alt: `${route.key} 대표 이미지`,
    },
    toc: sections.map((s) => ({ id: s.id, label: s.heading })),
    sections,
    widgets,
  }
}

const WIDGET_LABEL: Record<WidgetSpec['kind'], string> = {
  toc: '목차',
  share: '공유',
  note: '메모',
}
