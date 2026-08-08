import type { SectionSpec } from '@/lib/data'

/** 지시어 없음 — 두 그래프 공용. DOM 노드 수의 대부분을 차지한다. */
export function SectionBlock({ section }: { section: SectionSpec }) {
  return (
    <section id={section.id} className="section">
      <h2>{section.heading}</h2>
      {section.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </section>
  )
}
