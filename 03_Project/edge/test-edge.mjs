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

// ── Lambda@Edge ────────────────────────────────────────────────────────────
// Windows 절대 경로는 file:// URL로 바꿔야 ESM 로더가 받는다 ('c:'를 스킴으로 읽는다).
const { handler } = await import(pathToFileURL(join(HERE, 'dist', 'index.mjs')).href)
const originEvent = (uri, headers) => ({ Records: [{ cf: { request: { uri, headers: edgeHeaders(headers) } } }] })
const val = (r, n) => r.headers[n]?.[0]?.value

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
