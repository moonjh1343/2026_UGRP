import {
  MODEL_IS_FITTED,
  MODEL_VERSION,
  POLICY_NAMES,
  TAU,
  bundlesGenerated,
} from '@/policy'

import { createRequire } from 'node:module'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

/*
 * 해석 기준은 `import.meta.url`이 아니라 **cwd**다. 서버 번들 안에서
 * `import.meta.url`은 실제 파일 경로를 가리키지 않아 node_modules를 찾지 못한다
 * (처음 이렇게 짰다가 next·react가 둘 다 null로 나왔다). cwd는 로컬에서
 * `apps/benchmark/`, 런타임 이미지에서 `/app`이고 양쪽 다 node_modules를 품는다.
 */
const require_ = createRequire(join(process.cwd(), 'noop.js'))

/**
 * **실제로 설치되어 돌고 있는** 버전을 읽는다 — package.json의 의존성 범위가 아니라
 * node_modules에 들어간 것이다.
 *
 * 워커가 파일로 읽지 않고 여기로 물어보게 한 이유: 클라우드에서 워커 컨테이너에는
 * `apps/benchmark/`가 없어 `next`·`react`가 통째로 결측됐다(1샤드 검증에서 발견).
 * 재현성 요구사항이 명시적으로 요구하는 항목이고, 파일을 읽는 방식은 로컬에서만
 * 참이었다. 게다가 저장소의 package.json은 **배포된 이미지와 다를 수 있다** —
 * 답해야 하는 질문은 "지금 이 SUT가 무엇으로 돌고 있는가"다.
 */
function runtimeVersions() {
  const read = (mod: string) => {
    try {
      return require_(`${mod}/package.json`).version as string
    } catch {
      return null
    }
  }
  return { next: read('next'), react: read('react'), node: process.version }
}

/**
 * 결정 계층 내성(introspection). 검증 스크립트가 정책 목록·τ·모델 버전을
 * 하드코딩하지 않도록 노출한다.
 *
 * **이 라우트는 계측 도구이지 SUT의 일부가 아니다.** `/api/internal/*`는 5단계에서
 * 걷어낸다. 앱의 렌더 경로(`app/m/`, `components/`, `lib/render/`)가 `@/policy`를
 * 임포트하지 않는 것이 4단계 합격 기준이고, `check:policy`가 그 경계를 검사한다.
 */
export async function GET() {
  return Response.json(
    {
      policies: POLICY_NAMES,
      tau: TAU,
      model: { version: MODEL_VERSION, fitted: MODEL_IS_FITTED },
      bundlesGenerated: bundlesGenerated(),
      runtime: runtimeVersions(),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
