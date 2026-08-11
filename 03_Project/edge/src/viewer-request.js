/**
 * CloudFront Function — 뷰어 요청.
 *
 * **모든 요청에서 돈다(캐시 히트 포함).** 그래서 모델이 여기 없다. 하는 일은
 * Client Hints를 정규화된 버킷 문자열로 접는 것뿐이고, 그 버킷이 캐시 키에 들어간다.
 *
 * 왜 버킷인가: 모드를 그대로 캐시 키에 넣으면 기기·네트워크 조합만큼 캐시가 갈라져
 * 히트율이 0에 수렴한다. 버킷으로 접으면 라우트당 최대 64개(4×4×2×2)로 묶인다.
 * 반대로 버킷 없이 URL만 키로 쓰면, 첫 요청이 채운 모드를 모든 기기가 그대로 받아
 * 정책이 아무 효과도 내지 못한다.
 *
 * CloudFront Functions 런타임 제약: ES5.1 기반, 네트워크·파일시스템 없음, 1ms 미만,
 * 코드 10KB. 그래서 이 파일은 의도적으로 단순하다.
 */

// features.ts의 EFFECTIVE_TYPES와 같은 순서여야 한다. 어긋나면 버킷이 다른 것을 뜻하게 된다.
var EFFECTIVE_TYPES = ['slow-2g', '2g', '3g', '4g']

/**
 * 크롤러 판정.
 *
 * **features.ts의 BOT_UA와 문자 그대로 같아야 한다.** 이 판정은 버킷(캐시 키)을
 * 가르고, origin-request의 collect()가 같은 UA로 다시 판정해 SSR을 고정한다.
 * 두 판정이 어긋나면 — 예전에 여기만 9개 고정 문자열이었다 — features 쪽만 봇으로
 * 보는 UA(Discordbot, PetalBot, crawl* 류)의 SSR 응답이 **비봇 버킷에 캐시**되어,
 * 같은 버킷의 일반 사용자 전원이 TTL 동안 SSR을 받는다.
 *
 * **헤드리스 브라우저를 봇으로 잡으면 안 된다.** 측정 워커가 곧 헤드리스 Chrome이라,
 * `headlesschrome`을 여기 넣으면 모든 워커 요청이 봇 버킷으로 가서 정책이 실제로
 * 무엇을 고르는지 영영 관측되지 않는다. (이 정규식은 HeadlessChrome에 매치되지 않는다.)
 */
var BOT_UA = /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|duckduckgo/i

function isBot(ua) {
  return BOT_UA.test(ua)
}

/**
 * 기기 등급 1(저사양)~4(고사양).
 *
 * Client Hints가 없으면 3(중상)으로 둔다. 0이나 1로 두면 힌트를 안 보내는 브라우저
 * (Safari 등)가 전부 최저 사양으로 분류되어, 그 사용자군에 체계적으로 보수적인 모드가
 * 배정된다. features.ts의 결측 처리와 같은 방향이다.
 */
function deviceTier(h) {
  var mem = h['sec-ch-device-memory'] ? Number(h['sec-ch-device-memory'].value) : 0
  if (!mem) return 3
  if (mem >= 8) return 4
  if (mem >= 4) return 3
  if (mem >= 2) return 2
  return 1
}

function effectiveTypeIdx(h) {
  var ect = h['sec-ch-ect'] ? h['sec-ch-ect'].value : ''
  for (var i = 0; i < EFFECTIVE_TYPES.length; i++) {
    if (EFFECTIVE_TYPES[i] === ect) return i
  }
  return 3 // 결측은 4g로 본다 — 낙관이 아니라, 힌트 미지원 브라우저가 대개 데스크톱이다
}

function handler(event) {
  var req = event.request
  var h = req.headers

  var ua = h['user-agent'] ? h['user-agent'].value : ''
  var saveData = h['save-data'] && h['save-data'].value === 'on' ? 1 : 0

  var bucket = deviceTier(h) + '-' + effectiveTypeIdx(h) + '-' + (isBot(ua) ? 1 : 0) + '-' + saveData

  /*
   * 클라이언트가 직접 보낸 값을 덮어쓴다. 덮어쓰지 않으면 임의의 버킷을 요청해
   * 캐시를 오염시키거나, 봇 버킷을 위장해 SEO 고정을 우회할 수 있다.
   */
  req.headers['x-ugrp-bucket'] = { value: bucket }

  return req
}
