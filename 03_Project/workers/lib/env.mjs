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
    next: appPkg?.dependencies?.next ?? null,
    react: appPkg?.dependencies?.react ?? null,
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
