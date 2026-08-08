import { seeded } from '../rng'
import type { Route } from '../routes'
import { AUTHORS, HEADINGS, WORDS } from './lexicon'
import type { ContentPayload, SectionSpec, WidgetSpec } from './types'

/** 섹션 하나가 차지하는 대략적인 DOM 노드 수 — nodeCount에서 섹션 수를 역산한다 */
const NODES_PER_SECTION = 220
const PARAGRAPHS_PER_SECTION = 3
/** 어휘 평균 바이트 수(UTF-8 한글 3바이트 + 공백) */
const BYTES_PER_WORD = 10

export function generateContent(route: Route): ContentPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  const sectionCount = clamp(Math.round(route.nodeCount / NODES_PER_SECTION), 3, 40)
  const totalParagraphs = sectionCount * PARAGRAPHS_PER_SECTION
  const wordsPerParagraph = clamp(
    Math.round((route.payloadKB * 1024) / (totalParagraphs * BYTES_PER_WORD)),
    8,
    400,
  )

  const sections: SectionSpec[] = Array.from({ length: sectionCount }, (_, i) => {
    const id = `sec-${String(i + 1).padStart(2, '0')}`
    return {
      id,
      heading: `${i + 1}. ${rng.pick(HEADINGS)}`,
      paragraphs: Array.from({ length: PARAGRAPHS_PER_SECTION }, () =>
        sentence(rng, wordsPerParagraph),
      ),
    }
  })

  const widgets: WidgetSpec[] = Array.from({ length: route.interactiveCount }, (_, i) => {
    const kind: WidgetSpec['kind'] = i === 0 ? 'toc' : i === 1 ? 'share' : 'note'
    return { id: `w-${i + 1}`, kind, label: WIDGET_LABEL[kind] }
  })

  // 발행일은 시드에서 유도한다. Date.now()를 쓰면 반복마다 값이 달라져
  // 페이로드 바이트 수와 DOM 텍스트가 흔들린다.
  const dayOffset = rng.int(0, 3650)
  const publishedAt = new Date(Date.UTC(2016, 0, 1) + dayOffset * 86_400_000)
    .toISOString()
    .slice(0, 10)

  return {
    routeType: 'content',
    routeKey: route.key,
    title: `${rng.pick(HEADINGS)} — ${route.key}`,
    meta: {
      author: rng.pick(AUTHORS),
      publishedAt,
      readingMinutes: Math.max(1, Math.round((totalParagraphs * wordsPerParagraph) / 300)),
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

function sentence(rng: ReturnType<typeof seeded>, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(rng.pick(WORDS))
  return out.join(' ') + '.'
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
