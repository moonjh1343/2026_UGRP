import { seeded } from '../rng'
import type { Route } from '../routes'
import { ACTIVITY_LABELS, ADJECTIVES, NOUNS, WORDS } from './lexicon'
import { clamp, seededDate, sentence, wordsPerUnit } from './shared'
import type { PersonalizedPayload } from './types'

/**
 * 개인화형 — **캐시 불가 + 서버 부하 민감**이 지배 축이다.
 *
 * personalizedRatio = 1.0이므로 SSG·ISR 후보에서 배제된다(제안서 §3.1.1).
 * 요청마다 렌더해야 하므로 서버 부하가 높을 때 SSR이 급격히 불리해지고,
 * 그 구간에서 CSR로 기우는 것이 이 유형의 결정 경계다.
 *
 * 페이로드를 shared/personalized로 나누는 이유: 캐시 가능 영역과 불가 영역을
 * 분리해야 ISR의 부분 캐시 효과를 측정할 수 있다(설계 문서 §6).
 */
export function generatePersonalized(route: Route): PersonalizedPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  const blurbCount = clamp(Math.round(route.nodeCount / 300), 2, 20)
  const recCount = clamp(route.interactiveCount * 2, 4, 40)
  const words = wordsPerUnit(route.payloadKB, blurbCount + recCount, 0.9)

  return {
    routeType: 'personalized',
    routeKey: route.key,
    title: `내 작업 공간 — ${route.key}`,
    shared: {
      heading: `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}`,
      blurbs: Array.from({ length: blurbCount }, () => sentence(rng, words, WORDS)),
    },
    personalized: {
      // 사용자별 값이지만 시드로 고정한다 — 측정 반복 간 동일해야 한다
      greeting: `${rng.pick(NOUNS)}님의 오늘`,
      recommendations: Array.from({ length: recCount }, (_, i) => ({
        id: `rec-${String(i + 1).padStart(2, '0')}`,
        title: `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}`,
        score: Math.round(rng.next() * 1000) / 10,
      })),
      activity: Array.from({ length: 8 }, (_, i) => ({
        id: `act-${i + 1}`,
        label: rng.pick(ACTIVITY_LABELS),
        at: seededDate(rng, 60),
      })),
    },
  }
}
