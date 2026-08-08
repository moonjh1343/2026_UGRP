import { seeded } from '../rng'
import type { Route } from '../routes'
import { FIELD_LABELS, TAGS, WORDS } from './lexicon'
import { clamp, sentence } from './shared'
import type { FieldSpec, FormPayload } from './types'

const NODES_PER_FIELD = 8

const PATTERNS: Record<string, string | null> = {
  text: null,
  email: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$',
  tel: '^0\\d{1,2}-?\\d{3,4}-?\\d{4}$',
  number: '^\\d+$',
  select: null,
  textarea: null,
}

const KINDS: FieldSpec['kind'][] = ['text', 'email', 'tel', 'number', 'select', 'textarea']

/**
 * 폼형 — **인터랙션 준비(INP)**가 지배 축이다.
 *
 * DOM은 작지만 필드마다 검증기가 붙어 하이드레이션 대상이 많고,
 * 입력마다 패턴 검증이 돌아 INP가 지배 지표가 된다.
 * Islands가 가장 잘 맞는 유형이다 — 정적 레이아웃은 서버에 남기고
 * 필드만 섬으로 두면 된다.
 */
export function generateForm(route: Route): FormPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  const fieldCount = clamp(route.interactiveCount, 4, 60)
  const sectionCount = clamp(Math.round(route.nodeCount / (NODES_PER_FIELD * 6)), 2, 8)

  /*
   * 필드를 **정확히 fieldCount개** 만든 뒤 섹션으로 쪼갠다.
   *
   * 섹션당 개수를 반올림해서 곱하면(round(13/8)=2, round(18/8)=2) 서로 다른
   * interactiveCount가 같은 총 필드 수로 붕괴한다. 실제로 form-02(13)와
   * form-03(18)이 둘 다 16개가 되어 인스턴스가 중복됐다.
   */
  const fields: FieldSpec[] = Array.from({ length: fieldCount }, (_, i) => {
    const n = i + 1
    const kind = KINDS[n % KINDS.length]
    return {
      id: `f-${String(n).padStart(2, '0')}`,
      label: `${rng.pick(FIELD_LABELS)} ${n}`,
      kind,
      required: n % 3 === 0,
      pattern: PATTERNS[kind],
      options: kind === 'select' ? Array.from({ length: 4 }, () => rng.pick(TAGS)) : [],
      help: sentence(rng, 6, WORDS),
      maxLength: kind === 'textarea' ? 500 : 80,
    }
  })

  const perSection = Math.ceil(fieldCount / sectionCount)
  const sections = Array.from({ length: sectionCount }, (_, s) => ({
    id: `fs-${s + 1}`,
    heading: `${s + 1}. ${rng.pick(TAGS)} 정보`,
    fields: fields.slice(s * perSection, (s + 1) * perSection),
  })).filter((s) => s.fields.length > 0)

  return {
    routeType: 'form',
    routeKey: route.key,
    title: `신청서 — ${route.key}`,
    sections,
  }
}
