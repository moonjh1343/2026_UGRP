/**
 * CLI 인자 파서 — run·verify-variance·diagnose-tail·quarantine이 각자 들고 있던
 * 복사본 네 벌을 모은 것.
 *
 * 복사본 중 quarantine 판만 값 없는 플래그를 안전하게 처리했다: 다음 토큰이
 * `--`로 시작하면 값으로 삼지 않는다. 나머지 판은 `--reason --requeue`처럼 값이
 * 빠진 자리에서 **다음 플래그를 값으로 집어삼켰다** — 오류 대신 그럴듯한 인자가
 * 만들어지는 유형이라, 안전한 쪽을 표준으로 한다.
 */
export function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v !== undefined && !v.startsWith('--') ? v : fallback
}

/** 쉼표 목록 인자. 공백은 다듬는다 — `--types content, dashboard`도 의도대로 읽힌다. */
export function list(name, fallback = null) {
  const v = arg(name, null)
  return v ? v.split(',').map((s) => s.trim()) : fallback
}

/** 값 없는 불리언 플래그. */
export const flag = (name) => process.argv.includes(`--${name}`)
