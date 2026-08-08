import { seeded } from '../rng'
import type { Route } from '../routes'
import { ADJECTIVES, NOUNS, TAGS, WORDS } from './lexicon'
import { clamp, sentence, wordsPerUnit } from './shared'
import type { ListItem, ListPayload } from './types'

/** 목록 항목 하나가 차지하는 DOM 노드 수 */
const NODES_PER_ITEM = 14

/**
 * 목록형 — **DOM 노드 수**가 지배 축이다.
 * 항목 수가 많아 서버 렌더 HTML도 크고 클라이언트 렌더 비용도 크다.
 *
 * personalizedRatio가 임계값(θ_p=0.2) 아래이므로 SSG 후보로 남는다.
 * 개인화는 `badge` 필드에 국한되며, ISR로 공용을 캐시하고 이 부분만
 * 클라이언트가 채우는 하이브리드가 성립한다(제안서 §3.1.1).
 */
export function generateList(route: Route): ListPayload {
  const rng = seeded(`${route.type}:${route.key}`)

  // 상한은 확산 최대 배율(nodeCount 8000)에서도 걸리지 않게 둔다 —
  // 걸리면 list-04와 list-05가 같은 페이로드가 되어 인스턴스 2개를 낭비한다.
  const itemCount = clamp(Math.round(route.nodeCount / NODES_PER_ITEM), 10, 1200)
  const words = wordsPerUnit(route.payloadKB, itemCount, 0.85)

  const items: ListItem[] = Array.from({ length: itemCount }, (_, i) => {
    const personalized = rng.next() < route.personalizedRatio
    return {
      id: `item-${String(i + 1).padStart(3, '0')}`,
      title: `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} ${i + 1}`,
      summary: sentence(rng, words, WORDS),
      price: rng.int(1000, 900_000),
      rating: Math.round(rng.next() * 50) / 10,
      tags: Array.from({ length: rng.int(1, 4) }, () => rng.pick(TAGS)),
      badge: personalized ? '추천' : null,
    }
  })

  const facets = Array.from({ length: 4 }, (_, i) => ({
    id: `facet-${i + 1}`,
    label: rng.pick(NOUNS),
    options: Array.from({ length: 5 }, () => rng.pick(TAGS)),
  }))

  return {
    routeType: 'list',
    routeKey: route.key,
    title: `${rng.pick(NOUNS)} 목록 — ${route.key}`,
    facets,
    items,
    totalCount: itemCount,
  }
}
