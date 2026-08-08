/**
 * 증류 트리 평가기 (제안서 §4.1 서빙 행).
 *
 * SageMaker 엔드포인트를 요청 경로에 두면 수십 ms가 붙어, 측정하려는 개선폭보다
 * 큰 비용이 된다. 그래서 GBDT를 깊이 5 트리로 증류해 **엣지 프로세스 안에서**
 * 평가한다. 실배포에서는 AppConfig가 이 JSON을 배포하고, 여기서는 정적 임포트다.
 *
 * 모드를 피처로 넣어 트리 하나가 M(x)의 모든 모드를 채점한다(제안서 §3.2의 Ĵ(x, m)).
 * 모드별로 트리를 두면 모드 간 순서가 트리 간 스케일 차이에 오염된다.
 */
import { MODES, type Mode } from '@/lib/modes'
import type { Features, Policy } from './types'
import { toVector } from './features'
import model from './model/tree.v0.json'

type Leaf = { leaf: number }
type Split = { feature: string; threshold: number; left: Node; right: Node }
type Node = Leaf | Split

const ROOT = model.root as unknown as Node
const MODE_INDEX = model.modeIndex as Record<string, number>

export const MODEL_VERSION: string = model.version

/** 학습 전 자리표시자인가. 실험 메타데이터에 반드시 기록해야 하는 사실이다. */
export const MODEL_IS_FITTED = model.version !== 'v0-unfitted'

function evalTree(node: Node, x: Record<string, number>): number {
  let cur = node
  // 깊이 5 트리라 반복 상한이 넉넉하다. 잘못된 JSON이 무한 루프가 되지 않게 막는다.
  for (let depth = 0; depth < 64; depth++) {
    if ('leaf' in cur) return cur.leaf
    const v = x[cur.feature]
    cur = (v ?? 0) <= cur.threshold ? cur.left : cur.right
  }
  throw new Error('증류 트리가 깊이 한계를 넘었다 — JSON이 손상되었을 수 있다')
}

/** Ĵ(x, m). 낮을수록 좋다. */
export function predict(f: Features, mode: Mode): number {
  const idx = MODE_INDEX[mode] ?? MODES.indexOf(mode)
  return evalTree(ROOT, toVector(f, mode, idx))
}

/**
 * argmin over M(x) (제안서 §3.2).
 *
 * 후보 밖 모드는 **채점하지 않는다.** 점수를 낸 뒤 거르는 것이 아니다 —
 * 개인화 라우트에서 SSG를 채점하면 캐시 히트 가정 때문에 항상 최소가 되고,
 * 그 점수가 로그에 남아 사후 분석에서 "SSG가 더 좋았는데 왜 안 썼나"라는
 * 존재하지 않는 손실로 읽힌다.
 */
export const surrogate: Policy = (f, cands) => {
  const scores: Partial<Record<Mode, number>> = {}
  let best = cands[0]
  let bestScore = Infinity

  for (const m of cands) {
    const s = predict(f, m)
    scores[m] = s
    if (s < bestScore) {
      bestScore = s
      best = m
    }
  }

  return { mode: best, scores }
}
