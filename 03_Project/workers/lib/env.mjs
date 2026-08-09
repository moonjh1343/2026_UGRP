/**
 * 실험 환경 기록.
 *
 * **브라우저 업데이트만으로 성능 특성이 바뀐다.** 버전을 남기지 않으면 몇 주 뒤의
 * 데이터와 지금 데이터를 같은 데이터셋으로 합칠 수 있는지 판단할 수 없고,
 * 판단할 수 없으면 합치면 안 된다 — 그 시점에 이전 데이터는 버려진다.
 *
 * 제안서 부록 B와 CLAUDE.md의 재현성 요구사항: Chrome·Playwright·Node·Next.js 버전과
 * 모든 시드를 실험 레코드에 넣는다.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

async function readJson(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'))
  } catch {
    return null
  }
}

export async function captureEnv({ base, browser, seeds }) {
  const workerPkg = await readJson(new URL('../package.json', import.meta.url))
  const appPkg = await readJson(new URL('../../apps/benchmark/package.json', import.meta.url))

  let playwrightVersion = null
  try {
    playwrightVersion = require('playwright/package.json').version
  } catch {
    /* 설치 경로가 다르면 생략한다 — 없다는 사실 자체가 기록된다 */
  }

  let policy = null
  try {
    policy = await (await fetch(`${base}/api/internal/policy`)).json()
  } catch {
    /* 앱이 아직 안 떴을 수 있다 */
  }

  return {
    capturedAt: new Date().toISOString(),
    base,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpuCount: (await import('node:os')).cpus().length,
    browser: {
      name: browser?.browserType?.().name?.() ?? 'chromium',
      version: browser ? await browser.version() : null,
    },
    playwright: playwrightVersion,
    /*
     * **SUT가 답한 값을 먼저 쓴다.** 저장소의 package.json을 읽는 것은 로컬에서만
     * 참이었다 — 클라우드에서는 워커 컨테이너에 `apps/benchmark/`가 없어 두 값이
     * 통째로 결측됐고(1샤드 검증에서 발견), 재현성 요구사항이 요구하는 항목이
     * 조용히 null로 남았다.
     *
     * 파일은 폴백으로만 둔다. 순서가 이런 이유는 결측 방지만이 아니다 — 저장소의
     * 의존성 범위와 배포된 이미지가 다를 수 있고, 데이터에 남아야 하는 것은
     * **그 측정을 실제로 처리한 SUT**의 버전이다.
     */
    next: policy?.runtime?.next ?? appPkg?.dependencies?.next ?? null,
    react: policy?.runtime?.react ?? appPkg?.dependencies?.react ?? null,
    sutNode: policy?.runtime?.node ?? null,
    worker: workerPkg?.version ?? null,
    /*
     * 정책 버전과 모델 버전. 5단계 수집 시점의 서러게이트가 미학습 자리표시자라면
     * 그 사실이 데이터셋에 박혀 있어야 한다 — 나중에 "이 데이터는 어떤 정책 아래에서
     * 모였나"를 물을 때 유일한 답이 된다.
     */
    policy: policy ? { tau: policy.tau, model: policy.model } : null,
    seeds,
  }
}
