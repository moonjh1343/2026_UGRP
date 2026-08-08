/**
 * 정책 플러그인 (설계 문서 §9).
 *
 * 실험군 전체가 **같은 코드 경로**를 타야 정책 간 비교가 공정하다. 고정 정책을
 * 별도 배포로 만들면 배포 시점·인프라 드리프트가 정책 효과와 섞인다.
 *
 * 고정 정책도 후보 밖 모드를 반환할 수 있고, 그 실행 불가능성은 `decide()`가
 * 폴백으로 처리하며 **폴백 발생 자체를 기록한다.** 정책이 스스로 후보 안으로
 * 접어버리면 "fixed-ssg가 개인화 라우트에서 몇 번 성립하지 못했는가"를 셀 수 없고,
 * 그러면 기준선 비교 결과를 해석할 수 없다.
 */
import type { Mode } from '@/lib/modes'
import type { Features, Policy } from './types'
import { surrogate } from './surrogate'

const fixed =
  (want: Mode): Policy =>
  () => ({ mode: want })

/**
 * 휴리스틱 기준선 (제안서 §4.1). 실무에서 흔히 쓰이는 임계값 규칙이며,
 * 학습 모델이 이겨야 하는 대상이다.
 */
const ruleBased: Policy = (f: Features) => {
  const weak = f.deviceTier <= 2 || f.effectiveType === '3g' || f.effectiveType === '2g'
  const slowNet = f.effectiveType === 'slow-2g' || f.saveData
  const busy = f.cpuPct > 80
  if (slowNet) return { mode: 'ssg' }
  return { mode: weak || busy ? 'ssr' : 'csr' }
}

export const POLICIES: Record<string, Policy> = {
  'fixed-csr': fixed('csr'),
  'fixed-ssr': fixed('ssr'),
  'fixed-stream': fixed('stream'),
  'fixed-ssg': fixed('ssg'),
  'fixed-islands': fixed('islands'),
  'rule-based': ruleBased,
  surrogate,
}

export const POLICY_NAMES = Object.keys(POLICIES)

export function resolvePolicy(name: string | null | undefined): { name: string; fn: Policy } | null {
  if (!name) return null
  // Object.hasOwn — 프로토타입 오염(`x-policy: toString`)으로 함수가 잡히면 안 된다
  if (!Object.hasOwn(POLICIES, name)) return null
  return { name, fn: POLICIES[name] }
}
