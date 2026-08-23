/**
 * 엣지 핸들러 검증 — 실제 CloudFront 이벤트 모양으로 돌린다.
 *
 * AWS 없이 확인할 수 있는 것이 대부분이고, 확인해야 하는 것도 대부분 여기 있다:
 * 캐시 키 버킷, SEO 고정이 뒤집히지 않는지, 상관 ID가 위조 불가한지, 성향 점수가
 * 확률로서 말이 되는지, 추론이 2ms 예산 안인지.
 *
 *   npm run build -- --origin https://x  &&  npm test
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures++
}

// ── CloudFront Function 로드 ────────────────────────────────────────────────
// CF Functions는 모듈이 아니라 전역 `handler`를 노출한다. 파일을 그대로 평가한다.
const viewerSrc = await readFile(join(HERE, 'src', 'viewer-request.js'), 'utf8')
const viewerHandler = new Function(`${viewerSrc}; return handler`)()

/*
 * 두 런타임의 헤더 형식이 다르다. 섞으면 조용히 undefined를 읽는다.
 *   CloudFront Functions — { 'user-agent': { value: '…' } }
 *   Lambda@Edge          — { 'user-agent': [{ key: 'User-Agent', value: '…' }] }
 */
const cfFnHeaders = (o) => {
  const out = {}
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = { value: String(v) }
  return out
}
const edgeHeaders = (o) => {
  const out = {}
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = [{ key: k, value: String(v) }]
  return out
}
const viewerEvent = (uri, headers) => ({ request: { uri, headers: cfFnHeaders(headers) } })

console.log('\nA. 뷰어 요청 — 캐시 키 버킷')
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'Sec-CH-Device-Memory': '8', 'Sec-CH-ECT': '4g' }))
  check('고사양·4g → 4-3-0-0', r.headers['x-ugrp-bucket'].value === '4-3-0-0', r.headers['x-ugrp-bucket'].value)
}
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'Sec-CH-Device-Memory': '1', 'Sec-CH-ECT': '2g', 'Save-Data': 'on' }))
  check('저사양·2g·절약 → 1-1-0-1', r.headers['x-ugrp-bucket'].value === '1-1-0-1', r.headers['x-ugrp-bucket'].value)
}
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }))
  check('크롤러는 봇 자리가 1', r.headers['x-ugrp-bucket'].value.split('-')[2] === '1', r.headers['x-ugrp-bucket'].value)
}
{
  // 워커가 헤드리스 Chrome이다. 봇으로 잡히면 정책이 무엇을 고르는지 영영 관측되지 않는다.
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0 HeadlessChrome/143.0.0.0' }))
  check('헤드리스는 봇이 아니다', r.headers['x-ugrp-bucket'].value.split('-')[2] === '0', r.headers['x-ugrp-bucket'].value)
}
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '9-9-9-9' }))
  check('클라이언트가 보낸 버킷을 덮어쓴다', r.headers['x-ugrp-bucket'].value !== '9-9-9-9', r.headers['x-ugrp-bucket'].value)
}
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0' }))
  check('힌트 결측은 중상(3)으로', r.headers['x-ugrp-bucket'].value.startsWith('3-'), r.headers['x-ugrp-bucket'].value)
}

console.log('\nA1. 결정 헤더 위조를 막는다')
{
  /*
   * 이 이름들은 오리진 요청 정책의 allowList에 있다(그래야 Lambda@Edge가 얹은 값이
   * 오리진에 닿는다). allowList는 뷰어가 보낸 같은 이름도 통과시키므로, 뷰어 함수가
   * 먼저 지우지 않으면 클라이언트가 결정 계층을 우회할 수 있다.
   */
  const forged = {
    'user-agent': 'Mozilla/5.0',
    'x-render-mode': 'csr',
    'x-correlation-id': 'forged-cid',
    'x-decision-reason': 'policy',
    'x-ugrp-propensity': '1.0',
    'x-cell-device-tier': '4',
  }
  const r = viewerHandler(viewerEvent('/content/content-01', forged))
  for (const h of Object.keys(forged)) {
    if (h === 'user-agent') continue
    check(`${h} 는 제거된다`, r.headers[h] === undefined, String(r.headers[h]?.value))
  }
}

console.log('\nA2. 계측 엔드포인트는 공개 배포로 나가지 않는다')
{
  // 무인증 POST 한 번으로 ISR 캐시가 비워진다 — 열어두면 측정 대상(캐시 적중률)이 파괴된다.
  const r = viewerHandler(viewerEvent('/api/internal/revalidate', { 'user-agent': 'Mozilla/5.0' }))
  check('revalidate는 403', r.statusCode === 403, String(r.statusCode))
}
{
  const r = viewerHandler(viewerEvent('/api/internal/records', { 'user-agent': 'Mozilla/5.0' }))
  check('records는 403', r.statusCode === 403, String(r.statusCode))
}
{
  // 결정 계층이 서버 상태를 여기서 읽는다. 막으면 부하 피처가 영원히 0이다.
  const r = viewerHandler(viewerEvent('/api/internal/metrics', { 'user-agent': 'Mozilla/5.0' }))
  check('metrics는 통과한다', r.statusCode === undefined && Boolean(r.headers))
}
{
  const r = viewerHandler(viewerEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0' }))
  check('일반 라우트는 통과한다', r.statusCode === undefined && Boolean(r.headers['x-ugrp-bucket']))
}

// ── Lambda@Edge ────────────────────────────────────────────────────────────
// Windows 절대 경로는 file:// URL로 바꿔야 ESM 로더가 받는다 ('c:'를 스킴으로 읽는다).
const { handler } = await import(pathToFileURL(join(HERE, 'dist', 'index.mjs')).href)
/** 실제 오리진 요청 이벤트에는 config가 함께 온다 — 서버 상태를 읽을 도메인이 여기서 나온다. */
const DIST = 'd111111abcdef8.cloudfront.net'
const originEvent = (uri, headers) => ({
  Records: [
    {
      cf: {
        config: { distributionDomainName: DIST, eventType: 'origin-request' },
        request: { uri, headers: edgeHeaders(headers) },
      },
    },
  ],
})
const val = (r, n) => r.headers[n]?.[0]?.value

console.log('\nB0. 서버 상태는 배포판을 거쳐 읽는다')
{
  /*
   * ALB를 직접 치면 SG(CloudFront 프리픽스 리스트)에 막혀 조용히 실패하고, 서버 상태
   * 피처가 영원히 0으로 굳는다. 이 검사는 **첫 핸들러 호출이어야 한다** — 스냅샷
   * 캐시가 모듈 스코프라 뒤에 오면 TTL·진행중 플래그에 걸려 갱신이 예약되지 않는다.
   */
  const realFetch = globalThis.fetch
  let called = null
  globalThis.fetch = (url) => {
    called = String(url)
    return Promise.resolve({ ok: false })
  }
  await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '4-3-0-0' }))
  globalThis.fetch = realFetch
  check('ALB가 아니라 배포 도메인에서 읽는다', called === `https://${DIST}/api/internal/metrics`, String(called))
}

console.log('\nB. 오리진 요청 — 결정')
{
  const r = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '4-3-0-0' }))
  check('x-render-mode를 설정한다', Boolean(val(r, 'x-render-mode')), val(r, 'x-render-mode'))
  check('상관 ID를 발급한다', /^[0-9a-f-]{36}$/.test(val(r, 'x-correlation-id') ?? ''), val(r, 'x-correlation-id'))
  check('결정 사유를 남긴다', Boolean(val(r, 'x-decision-reason')), val(r, 'x-decision-reason'))
  check('성향 점수를 남긴다', Number(val(r, 'x-ugrp-propensity')) > 0, val(r, 'x-ugrp-propensity'))
  const us = Number(val(r, 'x-policy-us'))
  check('추론 < 2ms (4단계 합격 기준)', us < 2000, `${us.toFixed(1)}µs`)
}
{
  // 공개 라우트가 아니면 손대지 않는다 — 정적 자산에 결정 헤더가 붙을 이유가 없다.
  const r = await handler(originEvent('/_next/static/chunk.js', { 'user-agent': 'Mozilla/5.0' }))
  check('정적 자산은 건드리지 않는다', !val(r, 'x-render-mode') && !val(r, 'x-correlation-id'))
}
{
  const r = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-correlation-id': 'forged-by-client' }))
  check('클라이언트 cid를 신뢰하지 않는다', val(r, 'x-correlation-id') !== 'forged-by-client', val(r, 'x-correlation-id'))
}

console.log('\nC. SEO 고정은 뒤집히지 않는다')
{
  const r = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '4-3-1-0' }))
  check('봇 버킷 → ssr', val(r, 'x-render-mode') === 'ssr', `${val(r, 'x-render-mode')} / ${val(r, 'x-decision-reason')}`)
  check('봇은 탐색 대상이 아니다', val(r, 'x-decision-reason') !== 'explore', val(r, 'x-decision-reason'))
}
{
  // 탐색을 100%로 강제해도 봇은 고정이어야 한다.
  const real = Math.random
  Math.random = () => 0
  const r = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '4-3-1-0' }))
  Math.random = real
  check('탐색이 걸려도 봇은 ssr', val(r, 'x-render-mode') === 'ssr', val(r, 'x-render-mode'))
}

console.log('\nD. 버킷이 피처로 되돌아간다')
{
  const a = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '1-0-0-0' }))
  const b = await handler(originEvent('/content/content-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '4-3-0-0' }))
  check('주입된 기기 등급이 반영된다', val(a, 'x-cell-device-tier') === '1' && val(b, 'x-cell-device-tier') === '4')
  check('주입된 유효 네트워크가 반영된다', val(a, 'x-cell-effective-type') === 'slow-2g' && val(b, 'x-cell-effective-type') === '4g')
}

console.log('\nE. 성향 점수')
{
  const real = Math.random
  Math.random = () => 0 // 항상 탐색
  const explored = await handler(originEvent('/dashboard/dashboard-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '3-3-0-0' }))
  Math.random = () => 0.99 // 절대 탐색 안 함
  const greedy = await handler(originEvent('/dashboard/dashboard-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '3-3-0-0' }))
  Math.random = real

  const pe = Number(val(explored, 'x-ugrp-propensity'))
  const pg = Number(val(greedy, 'x-ugrp-propensity'))
  check('탐색 시 사유가 explore', val(explored, 'x-decision-reason') === 'explore', val(explored, 'x-decision-reason'))
  check('확률로서 유효 (0<p<=1)', pe > 0 && pe <= 1 && pg > 0 && pg <= 1, `explore=${pe} greedy=${pg}`)
  check('탐색 성향 < 정책 성향', pe < pg, `${pe} < ${pg}`)
}

console.log('\nF. 결정론 — 같은 입력, 같은 모드')
{
  const real = Math.random
  Math.random = () => 0.99 // 탐색 없이
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    const r = await handler(originEvent('/list/list-01', { 'user-agent': 'Mozilla/5.0', 'x-ugrp-bucket': '2-2-0-0' }))
    seen.add(val(r, 'x-render-mode'))
  }
  Math.random = real
  check('같은 버킷은 같은 모드', seen.size === 1, [...seen].join(','))
}

console.log(failures === 0 ? '\n통과' : `\n실패 ${failures}건`)
process.exit(failures === 0 ? 0 : 1)
