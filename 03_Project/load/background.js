/**
 * 배경 부하 — k6 스크립트 (배포 산출물).
 *
 * ECS Fargate Spot에서 실행하며, **측정 워커와 다른 서브넷·보안 그룹**에 둔다.
 * 같은 노드에 두면 부하 생성 CPU가 측정 워커의 브라우저와 경쟁해, 스로틀링으로
 * 통제하려던 클라이언트 조건이 무너진다(제안서 §6).
 *
 * VU 수는 여기서 정하지 않는다. `calibrate.mjs`가 목표 CPU에 도달하는 VU를 이진 탐색해
 * 셀 정의에 **고정**하고, 실행 시 `-e VUS=…`로 주입한다. 오토스케일링과
 * `desiredCount` 변동은 반드시 꺼야 한다 — 부하가 스스로 변하면 외생 변수가 아니다.
 *
 *   k6 run -e BASE_URL=https://… -e VUS=42 -e DURATION=30m background.js
 *
 * 라우트 믹스는 `profile.json`에서 읽는다. 로컬 대체본(generator.mjs)과 **같은 파일**을
 * 읽어야 로컬에서 캘리브레이션한 VU 수를 배포에 옮길 수 있다.
 */
import http from 'k6/http'
import { fail, sleep } from 'k6'

const profile = JSON.parse(open('./profile.json'))

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000'
const VUS = Number(__ENV.VUS || 10)
const DURATION = __ENV.DURATION || '5m'
const THINK_S = Number(profile.thinkTimeMs || 0) / 1000

/** 가중치를 펼친 URL 배열. init 단계에서 한 번만 만든다. */
const URLS = profile.routes.flatMap((r) => {
  const path = profile.path
    .replace('{mode}', profile.mode)
    .replace('{type}', r.type)
    .replace('{key}', r.key)
  return Array(r.weight).fill(`${BASE}${path}`)
})

export const options = {
  scenarios: {
    background: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '10s',
    },
  },
  /*
   * 임계값을 두지 않는다. 이 스크립트의 목적은 SLO 검증이 아니라 **부하를 만드는 것**이고,
   * 부하 구간에서 응답이 느려지는 것은 실패가 아니라 의도한 조건이다.
   * k6의 측정값을 Web Vitals로 쓰면 안 된다(설계 문서 §11-6) — k6는 렌더하지 않는다.
   */
  thresholds: {},
  discardResponseBodies: false, // 본문을 버리면 서버가 스트리밍을 중단해 부하가 가벼워진다
}

export function setup() {
  if (URLS.length === 0) fail('profile.json에 라우트가 없다')
  return { count: URLS.length }
}

export default function () {
  // VU·반복마다 다른 지점에서 시작해 같은 라우트에 동시 몰림을 피한다
  const idx = (__VU * 7 + __ITER) % URLS.length
  http.get(URLS[idx], { tags: { role: 'background' } })

  /*
   * 요청 사이 대기. 없으면 VU 하나가 코어의 절반을 먹어 부하 수준을 조절할 수 없다 —
   * VU는 정수이므로 VU당 기여가 크면 격자가 거칠어진다. 로컬 실측에서 대기 없이
   * VU=1이 이미 CPU 50.8%였고 목표 30%에 도달할 방법이 없었다.
   * 로컬 생성기와 **같은 값**을 써야 캘리브레이션 결과가 옮겨진다.
   */
  if (THINK_S > 0) sleep(THINK_S)
}
