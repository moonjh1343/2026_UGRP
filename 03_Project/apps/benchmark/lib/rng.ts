/**
 * 결정적 난수. 같은 시드 → 항상 같은 수열.
 *
 * Math.random()과 Date.now()를 앱 전체에서 금지하는 이유는 §5.2의 반복 측정 때문이다.
 * 셀당 30회 반복의 분산이 곧 측정 노이즈이므로, 페이로드가 반복마다 흔들리면
 * 모드 간 차이 신호가 그 노이즈에 묻힌다.
 */

/** FNV-1a 32비트 해시. 라우트 키 → 시드. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 PRNG. 상태 32비트, 주기 2^32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = {
  next(): number
  int(minInclusive: number, maxExclusive: number): number
  pick<T>(items: readonly T[]): T
}

export function seeded(seedSource: string): Rng {
  const next = mulberry32(fnv1a(seedSource))
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
    pick: (items) => items[Math.floor(next() * items.length)],
  }
}
