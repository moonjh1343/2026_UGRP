/**
 * 렌더링 모드 정의. 제안서 §3.1의 전체 모드 집합 M.
 */
export const MODES = ['csr', 'ssr', 'stream', 'ssg', 'islands'] as const
export type Mode = (typeof MODES)[number]

/** 마진 폴백·서킷 브레이커의 기본 모드. 제안서 §3.5. */
export const DEFAULT_MODE: Mode = 'stream'

export function isMode(v: string): v is Mode {
  return (MODES as readonly string[]).includes(v)
}
