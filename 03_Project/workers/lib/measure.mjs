/**
 * 한 셀의 1회 측정.
 *
 * 지켜야 하는 것들이 서로 얽혀 있어 순서가 곧 설계다.
 *
 *  1. 반복마다 **새 브라우저 컨텍스트** — 캐시·스토리지가 남으면 콜드/웜이 섞인다(§11-4)
 *  2. CDP 스로틀링을 **네비게이션 전에** 건다 — 후에 걸면 첫 바이트가 무제한 대역으로 온다
 *  3. 워커가 건 조건을 `x-cell-*` 헤더로 **주입한다** — CDP 스로틀링은 Client Hints를
 *     바꾸지 않아서, 안 하면 결정 계층이 보는 기기·네트워크가 전부 상수가 된다(§11-17)
 *  4. SSG는 캐시 상태를 **셀 변수로 통제한다** — 안 하면 한 셀 안에서 미스와 히트가 섞여
 *     분산이 폭발한다(§11-3). 이것이 5단계 합격 기준에 직접 걸린다
 *  5. 상호작용을 주입한다 — INP는 자연 발생하지 않는다
 *  6. 페이지를 떠나 비콘을 flush하고, **cid로 조인해** 지표를 가져온다
 *
 * 지표를 워커가 직접 재지 않는 이유: `getEntriesByType`으로는 LCP도 롱태스크도 잡히지
 * 않는다(§11-14). 앱의 비콘 파이프라인이 유일한 경로다.
 */
import { deviceOf, networkOf } from './grid.mjs'
import { runSequence } from './interactions.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** SSG의 stale 상태를 만들려면 revalidate 창(60초)이 지나야 한다. */
const REVALIDATE_MS = 60_000
const STALE_MARGIN_MS = 2000

function pageUrl(base, cell) {
  return `${base}/m/${cell.mode}/${cell.routeType}/${cell.routeKey}`
}

async function revalidate(base, cell) {
  const res = await fetch(
    `${base}/api/internal/revalidate?type=${cell.routeType}&key=${cell.routeKey}`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`무효화 실패: HTTP ${res.status}`)
  await res.arrayBuffer()
}

/** 본문을 끝까지 읽어야 실제 렌더가 완료된다 — 헤더만 받고 끊으면 캐시가 채워지지 않는다. */
async function warm(base, cell) {
  const res = await fetch(pageUrl(base, cell))
  await res.arrayBuffer()
  return res.headers.get('x-nextjs-cache')
}

/**
 * 캐시 상태를 셀이 요구하는 값으로 만든다. 측정 요청 **직전**에 수행한다.
 *
 * `stale`은 비싸다: 엔트리를 만든 뒤 revalidate 창이 지나야 하고, stale 응답 한 번이
 * 백그라운드 재생성을 유발하므로 **반복마다 다시 기다려야 한다**(반복당 ~62초).
 * `revalidate`가 세그먼트 설정 리터럴이라 실험용으로 줄일 수 없는 것이 원인이다.
 * 실제 수집에서는 짧은 revalidate를 가진 SSG 라우트 계열을 따로 두는 편이 낫다 —
 * 이는 앱 설계 변경이므로 여기서는 비용을 감수하고 그대로 잰다.
 */
async function prepareCache(base, cell, { allowStale }) {
  if (cell.mode !== 'ssg') return { prepared: 'n/a' }

  if (cell.cache === 'miss') {
    await revalidate(base, cell)
    return { prepared: 'miss' }
  }
  if (cell.cache === 'hit') {
    await revalidate(base, cell)
    await warm(base, cell) // 이 요청이 MISS를 소진하고 엔트리를 채운다
    return { prepared: 'hit' }
  }
  if (cell.cache === 'stale') {
    if (!allowStale) return { prepared: 'skipped', reason: 'stale 비활성' }
    await revalidate(base, cell)
    await warm(base, cell)
    await sleep(REVALIDATE_MS + STALE_MARGIN_MS)
    return { prepared: 'stale' }
  }
  return { prepared: cell.cache }
}

/**
 * 비콘은 `pagehide`에 발화하므로 페이지를 떠난 뒤에야 도착한다.
 * cid로 조인되지 않으면 그 반복은 **버린다** — 조인 안 되는 측정값은 피처가 없는 라벨이라
 * 학습에 쓸 수 없다.
 */
async function fetchBeacon(base, cid, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    /*
     * cid 필터를 서버에 넘긴다. 전체 덤프(링 버퍼 5000건×2)를 rep마다 최대
     * 20회 직렬화시키는 것은 idle 셀의 "배경 부하 0" 전제에 반하는 비계측
     * 비용이었다 — 필터하면 응답이 상수 크기다.
     */
    const dump = await (await fetch(`${base}/api/internal/records?cid=${encodeURIComponent(cid)}`)).json()
    const beacon = dump.beacons.find((b) => b.cid === cid)
    if (beacon) {
      const renders = dump.renders.filter((r) => r.cid === cid)
      return { beacon, renders }
    }
    await sleep(200)
  }
  return null
}

export async function measureOnce({ base, browser, cell, rep, allowStale = true }) {
  const device = deviceOf(cell.device)
  const network = networkOf(cell.network)
  const cachePrep = await prepareCache(base, cell, { allowStale })
  if (cachePrep.prepared === 'skipped') {
    return { ok: false, reason: 'stale-skipped', cell, rep }
  }

  // 1. 반복마다 새 컨텍스트 — 캐시·스토리지·쿠키가 전부 초기화된다
  const context = await browser.newContext({
    extraHTTPHeaders: {
      // 3. CDP 스로틀링이 바꾸지 않는 조건을 명시적으로 알려준다
      'x-cell-device-tier': String(device.tier),
      'x-cell-effective-type': network.ect,
      'x-cell-rtt-ms': String(network.latency),
      'x-cell-downlink': String(network.downlink),
      'x-exp-cell': `${cell.device}|${cell.network}|${cell.load}|${cell.cache}`,
    },
  })

  const page = await context.newPage()
  const client = await context.newCDPSession(page)

  try {
    // 2. 네비게이션 전에 스로틀링
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: network.latency,
      downloadThroughput: network.down,
      uploadThroughput: network.up,
    })
    await client.send('Emulation.setCPUThrottlingRate', { rate: device.cpuThrottle })

    const t0 = Date.now()
    const res = await page.goto(pageUrl(base, cell), { waitUntil: 'domcontentloaded' })
    if (!res || res.status() !== 200) {
      return { ok: false, reason: `HTTP ${res?.status() ?? 'none'}`, cell, rep }
    }

    const headers = res.headers()
    const cid = headers['x-correlation-id'] ?? null
    const cacheStatus = headers['x-nextjs-cache'] ?? null

    // CSR·Streaming은 스켈레톤을 먼저 그린다. 최종 트리가 붙어야 측정 대상이다.
    await page.waitForSelector('#app-root [data-route]', { timeout: 60_000 })
    /*
     * 스트리밍은 응답이 여러 청크로 나뉘므로 마지막 청크 도착 후 안정화까지 기다려야
     * LCP가 확정된다(§11-11). networkidle이 그 대리 신호다.
     */
    await page.waitForLoadState('networkidle')

    // 5. 상호작용 — INP는 이것 없이는 결측된다
    const interaction = await runSequence(page, cell.routeType)

    /*
     * 6. 이탈 → pagehide → sendBeacon
     *
     * `visibilitychange`를 인위적으로 dispatch하는 것은 소용없다 —
     * 리스너는 `document.visibilityState`를 다시 확인하는데 그 값은 여전히 'visible'이다.
     * web-vitals도 같은 확인을 하므로 onLCP가 확정되지 않는다. 그래서 앱의 Beacon에
     * 자체 LCP 폴백 관측자를 둔 것이고(2단계), 여기서는 pagehide만 믿는다.
     */
    await page.goto('about:blank')
    await sleep(300)

    const joined = cid ? await fetchBeacon(base, cid) : null
    if (!joined) {
      return { ok: false, reason: cid ? '비콘 미도착' : '응답에 cid 없음', cell, rep }
    }

    /*
     * **관측된 캐시 판정이 셀이 요구한 상태와 일치해야 한다.** 준비(prepareCache)만
     * 하고 확인하지 않으면, 재검증 타이밍이 어긋난 rep(hit 준비 후 STALE 관측 등)이
     * ok:true로 셀에 섞인다 — 캐시 상태를 셀 변수로 통제한 이유(분산 폭발)를
     * 정확히 무력화하는 경로인데, 사후에는 원인 불명의 이상치로만 보인다.
     * 불일치는 실패로 돌려 그 rep이 재시도·기각되게 한다.
     */
    if (cell.mode === 'ssg' && ['miss', 'hit', 'stale'].includes(cell.cache)) {
      const observed = (cacheStatus ?? '').toLowerCase()
      if (observed !== cell.cache) {
        return {
          ok: false,
          reason: `캐시 불일치: 기대 ${cell.cache}, 관측 ${cacheStatus ?? '(없음)'}`,
          cell,
          rep,
        }
      }
    }

    /*
     * 캐시 판정은 워커만 볼 수 있다 — 서버가 집계할 수 있도록 되돌려 보낸다.
     * `/api/beacon`이 아니라 전용 경로를 쓰는 이유: 같은 cid로 비콘 레코드가 두 건 생기면
     * cid로 조인하는 쪽이 지표 없는 쪽을 집어 결측으로 판정한다.
     */
    if (cacheStatus) {
      await fetch(`${base}/api/internal/cache-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cacheStatus }),
      }).catch(() => {})
    }

    const m = joined.beacon.metrics ?? {}
    return {
      ok: true,
      cell,
      rep,
      cid,
      wallMs: Date.now() - t0,
      cacheStatus,
      cachePrepared: cachePrep.prepared,
      metrics: {
        LCP: m.LCP ?? null,
        INP: m.INP ?? null,
        TBT: m.TBT ?? null,
        TTFB: m.TTFB ?? null,
        CLS: m.CLS ?? null,
        longTasks: m.longTasks ?? null,
        transferSize: m.transferSize ?? null,
        encodedBodySize: m.encodedBodySize ?? null,
        /** 스트리밍 청크 전달 구간 — 제어 불가능한 축의 공변량(설계 문서 §11-32) */
        responseDuration: m.responseDuration ?? null,
      },
      attribution: joined.beacon.attribution ?? {},
      /*
       * 부하 구간의 per-request CPU는 오염된다(다른 요청의 작업이 델타에 섞인다).
       * 값을 버리지 않고 부하 수준과 함께 남겨, 나중에 Idle 셀만 골라
       * C_render를 산출할 수 있게 한다(§7).
       */
      serverRenderCpuUs: joined.renders.reduce((s, r) => s + r.cpuUs, 0),
      serverRenderWallMs: joined.renders.reduce((s, r) => s + r.wallMs, 0),
      serverRenderCount: joined.renders.length,
      hydrationErrors: joined.beacon.hydrationErrors ?? 0,
      interaction,
    }
  } finally {
    await context.close().catch(() => {})
  }
}
