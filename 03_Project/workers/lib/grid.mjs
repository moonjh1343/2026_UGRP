/**
 * 조건 그리드 (제안서 §5.2).
 *
 * 그리드는 **버전 관리되는 코드**여야 한다. 애드혹 스크립트에 흩어지면 "그때 무슨 조건으로
 * 쟀는가"가 재현 불가능해지고, 그것만으로 데이터셋 전체의 가치가 사라진다.
 *
 *   조건 수 = 기기(4) × 네트워크(5) × 부하(4) × Σ_r |M(r)|
 *           + SSG 셀의 캐시 상태 축(×3)
 */
import { readFile } from 'node:fs/promises'

/**
 * 기기 등급 — CPU 스로틀 배율. 제안서 §5.2의 4수준.
 * `tier`는 결정 계층이 쓰는 1~4 스케일(1=저사양)이며 워커가 헤더로 주입한다.
 */
export const DEVICES = [
  { id: 'flagship', cpuThrottle: 1, tier: 4 },
  { id: 'mid', cpuThrottle: 2, tier: 3 },
  { id: 'low', cpuThrottle: 4, tier: 2 },
  { id: 'very-low', cpuThrottle: 6, tier: 1 },
]

/**
 * 네트워크 — CDP `Network.emulateNetworkConditions` 파라미터.
 * throughput은 bytes/s, latency는 ms(편도가 아니라 RTT로 적용된다).
 *
 * **`offline-first`의 해석에 주의.** 제안서 §5.2는 5번째 수준을 "Offline-first"라고 쓰는데,
 * 네트워크 조건으로서 완전 오프라인은 측정이 성립하지 않는다(페이지가 뜨지 않는다).
 * 여기서는 "오프라인 우선 설계가 필요할 만큼 열악한 망"으로 해석해 극단적 저대역·고지연
 * 프로파일로 구현했다. 다른 해석(예: Service Worker 캐시 히트 상태)을 의도했다면
 * 이 항목의 정의를 바꿔야 하고, 그것은 실험 설계 변경이다.
 */
export const NETWORKS = [
  { id: '5g', down: 100e6 / 8, up: 20e6 / 8, latency: 10, ect: '4g', downlink: 100 },
  { id: 'lte', down: 25e6 / 8, up: 10e6 / 8, latency: 50, ect: '4g', downlink: 25 },
  { id: '3g-fast', down: 1.6e6 / 8, up: 0.75e6 / 8, latency: 150, ect: '3g', downlink: 1.6 },
  { id: '3g-slow', down: 0.4e6 / 8, up: 0.4e6 / 8, latency: 400, ect: '3g', downlink: 0.4 },
  { id: 'offline-first', down: 0.25e6 / 8, up: 0.1e6 / 8, latency: 900, ect: 'slow-2g', downlink: 0.25 },
]

/** 서버 부하 — VU 수는 `load/calibration.generated.json`에서 온다. */
export const LOADS = ['idle', 'low', 'mid', 'high']

/**
 * ISR 캐시 상태 — SSG 셀에만 붙는 추가 축(제안서 §5.2).
 *
 * 명시적으로 통제하지 않으면 같은 셀 안에서 미스·히트·stale이 섞여 분산이 폭발하고,
 * §3.1.2의 missRate를 관측할 수 없다. 이것이 5단계 합격 기준(분산 < 모드 간 차이)에
 * 직접 걸리는 축이다.
 */
export const CACHE_STATES = ['miss', 'hit', 'stale']

/** SSG가 아닌 모드에는 캐시 상태 축이 없다 — 요청마다 렌더하므로 상태가 하나뿐이다. */
export const NO_CACHE_AXIS = 'n/a'

// --------------------------------------------------------------- 시드 PRNG

/** FNV-1a — 문자열 시드를 32비트 정수로. 앱의 lib/rng.ts와 같은 알고리즘이다. */
export function hashSeed(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 */
export function makeRng(seed) {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher-Yates. **조건 순서 무작위화는 선택이 아니라 요구사항이다**(제안서 §5.2) —
 * 순차 실행하면 실행 시간에 따른 인프라 드리프트(열 스로틀링, 캐시 워밍, GC 리듬)가
 * 특정 모드에 체계적으로 몰려 그 모드의 성능처럼 보인다. 시드는 실험 메타데이터에 기록한다.
 */
export function shuffle(arr, rng) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---------------------------------------------------------------- 그리드

export async function loadRouteTable(base) {
  const res = await fetch(`${base}/api/internal/routes`)
  if (!res.ok) throw new Error(`라우트 테이블 조회 실패: HTTP ${res.status}`)
  return res.json()
}

export async function loadCalibration() {
  try {
    const raw = await readFile(
      new URL('../../load/calibration.generated.json', import.meta.url),
      'utf8',
    )
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 셀 식별자. 체크포인트 키이자 데이터셋의 조인 키다. */
export function cellId(c) {
  return [c.device, c.network, c.load, c.routeType, c.routeKey, c.mode, c.cache].join('|')
}

/**
 * 전체 그리드를 펼친다.
 *
 * 실행 불가능한 조합은 **여기서 생기지 않는다.** 측정한 뒤 걸러내는 것이 아니라
 * 라우트 테이블의 `candidateModes`가 애초에 만들지 않는다(제안서 §3.1.1).
 */
export function expandGrid({ routes, filter = {} }) {
  const cells = []
  const devices = DEVICES.filter((d) => !filter.devices || filter.devices.includes(d.id))
  const networks = NETWORKS.filter((n) => !filter.networks || filter.networks.includes(n.id))
  const loads = LOADS.filter((l) => !filter.loads || filter.loads.includes(l))

  for (const device of devices) {
    for (const network of networks) {
      for (const load of loads) {
        for (const route of routes) {
          if (filter.types && !filter.types.includes(route.type)) continue
          if (filter.routeKeys && !filter.routeKeys.includes(route.key)) continue
          for (const mode of route.candidateModes) {
            if (filter.modes && !filter.modes.includes(mode)) continue
            const caches = mode === 'ssg' ? CACHE_STATES : [NO_CACHE_AXIS]
            for (const cache of caches) {
              if (mode === 'ssg' && filter.cacheStates && !filter.cacheStates.includes(cache)) {
                continue
              }
              cells.push({
                device: device.id,
                network: network.id,
                load,
                routeType: route.type,
                routeKey: route.key,
                mode,
                cache,
              })
            }
          }
        }
      }
    }
  }
  return cells
}

export const deviceOf = (id) => DEVICES.find((d) => d.id === id)
export const networkOf = (id) => NETWORKS.find((n) => n.id === id)
