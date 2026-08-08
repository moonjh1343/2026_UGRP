import type { Rng } from '../rng'

/** 어휘 평균 바이트 수(UTF-8 한글 3바이트 + 공백) */
export const BYTES_PER_WORD = 10

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function sentence(rng: Rng, words: number, corpus: readonly string[]): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(rng.pick(corpus))
  return out.join(' ') + '.'
}

/** 시드에서 유도한 날짜. Date.now()를 쓰면 반복마다 페이로드가 흔들린다. */
export function seededDate(rng: Rng, spanDays = 3650): string {
  const offset = rng.int(0, spanDays)
  return new Date(Date.UTC(2016, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

/**
 * payloadKB 목표에서 항목당 단어 수를 역산한다.
 *
 * 상한이 낮으면 인스턴스 확산의 상단이 잘려 서로 다른 라우트가 같은 페이로드가 된다.
 * (초기값 400에서 content-04/05가 111KB로 동일해졌다.) 상한은 확산 최대 배율에서도
 * 걸리지 않을 만큼 여유를 둔다.
 */
export function wordsPerUnit(payloadKB: number, units: number, share = 1): number {
  return clamp(Math.round((payloadKB * 1024 * share) / (units * BYTES_PER_WORD)), 4, 4000)
}
