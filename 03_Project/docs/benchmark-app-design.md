# 벤치마크 앱 구조 설계

`adaptive-rendering-research-proposal.md` 기준. 렌더링 모드 5종(CSR / SSR / Streaming SSR / SSG·ISR / Islands), 라우트 25종(콘텐츠·목록·대시보드·폼·개인화 각 5).

---

## 1. 이 앱이 만족해야 하는 것

벤치마크 앱은 "잘 만든 웹앱"이 아니라 **측정 도구**다. 일반적인 웹 개발 상식과 어긋나는 요구가 여럿 있다.

| 요구 | 이유 |
|---|---|
| 동일 UI를 5개 모드로 렌더 | 모드별 컴포넌트가 다르면 측정된 차이가 렌더 방식 때문인지 코드 차이 때문인지 구분 불가 |
| 모드가 **요청 시점**에 결정 | 빌드 시점 고정이면 애초에 이 연구가 성립하지 않음 |
| 출력이 완전 결정적 | 셀당 30회 반복의 분산이 곧 측정 노이즈. 페이로드가 흔들리면 신호가 묻힘 |
| 라우트 유형별로 모드 우열이 **갈려야** 함 | 25개 라우트가 모두 같은 모드를 선호하면 학습할 결정 경계가 없음 |
| 비용이 파라미터로 조절 가능 | 결정 경계를 격자 위에서 훑으려면 무게를 연속적으로 바꿀 수 있어야 함 |
| 라우트가 코드가 아니라 데이터 | 25개를 손으로 만들면 유지 불가능하고, 의도하지 않은 축에서 차이가 생김 |

네 번째가 설계 전체를 지배한다. 다섯 유형은 **의도적으로 서로 다른 축에서 무겁도록** 만든다(§5).

---

## 2. 모드 선택 메커니즘 — 경로 재작성

### 헤더 분기가 안 되는 이유

모드를 `x-render-mode` 헤더로 받아 페이지 안에서 분기하는 방식은 4개 모드까지는 되지만 **SSG/ISR에서 깨진다.** Next.js의 `dynamic`·`revalidate`는 세그먼트 단위 **정적** 설정이라 요청마다 바꿀 수 없다. SSG는 본질적으로 "요청 전에 이미 렌더되어 있음"이므로 요청 시점 분기로 표현할 수 없다.

### 채택: 내부 경로 분리 + 프록시 재작성

공개 URL은 하나로 두고, 결정 계층이 모드별 내부 경로로 재작성한다.

```
공개 URL          /content/deep-dive-01
                        │
                  결정 계층(프록시) — 피처 수집 → 정책 추론 → 모드 결정
                        │
내부 경로         /__m/ssg/content/deep-dive-01
```

```
app/__m/csr/content/[slug]/page.tsx        dynamic = 'force-dynamic'
app/__m/ssr/content/[slug]/page.tsx        dynamic = 'force-dynamic'
app/__m/stream/content/[slug]/page.tsx     dynamic = 'force-dynamic'
app/__m/ssg/content/[slug]/page.tsx        dynamic = 'force-static', revalidate = 60
app/__m/islands/content/[slug]/page.tsx    dynamic = 'force-dynamic'
```

각 파일은 공유 렌더러에 위임하는 5줄짜리 껍데기다. 파일 수는 5모드 × 5유형 = **25개**이고, 라우트 25종은 `[slug]` 파라미터로 표현되므로 파일이 늘지 않는다.

```tsx
// app/__m/ssg/content/[slug]/page.tsx
export const dynamic = 'force-static'
export const revalidate = 60
export const generateStaticParams = () => routesOf('content').map(r => ({ slug: r.key }))
export default renderFor('ssg', 'content')
```

### 이 방식이 공짜로 주는 것

- **캐시 키 분리.** 모드마다 경로가 다르므로 CDN·ElastiCache가 자동으로 분리 저장한다. "캐시 키에 모드를 넣어야 한다"는 규약을 사람이 지킬 필요가 없다 — 구조가 강제한다.
- **모드별 세그먼트 설정.** SSG의 `revalidate`, 스트리밍의 `Suspense` 경계를 모드마다 다르게 줄 수 있다.
- **실험 강제 지정.** factorial 수집 중에는 정책 대신 워커가 경로를 직접 찍는다. 동일 조건에서 5개 모드를 모두 측정해야 반사실 데이터가 나오기 때문이다.

### 계약

```
요청  x-correlation-id: <uuid>       결정 시점과 측정 시점을 잇는 키
      x-exp-cell: <cell_id>          factorial 셀 식별자
      x-session-id: <sid>            세션 단위 결정 캐싱·전환 상한용

응답  x-render-mode-applied           실제 적용된 모드 (하드 규칙 오버라이드 확인)
      x-server-cpu-us                 렌더 CPU 시간 (µs)
      x-cache-status                  hit | miss | stale  (SSG·ISR 판정용)
      x-correlation-id                그대로 반향
```

---

## 3. 컴포넌트 그래프 — 한 정의, 두 경계

5개 모드는 **하이드레이션 경계**에서 갈린다. 이것이 앱 구조에서 가장 까다로운 부분이다.

| 모드 | 트리의 위치 | 하이드레이션 |
|---|---|---|
| CSR | 클라이언트 그래프 | 전체 (클라이언트 렌더) |
| SSR | 클라이언트 그래프 | 전체 |
| Streaming SSR | 클라이언트 그래프 | 전체 (점진 전달) |
| SSG·ISR | 클라이언트 그래프 | 전체 |
| **Islands** | **서버 그래프** | **위젯만** |

Islands만 트리가 서버 그래프에 있다. RSC에서 서버 컴포넌트는 JS를 전송하지 않으므로, 트리를 서버 컴포넌트로 두고 인터랙티브 위젯만 `'use client'`로 두면 그것이 곧 Islands다.

문제는 **같은 트리가 두 그래프 모두에 필요**하다는 것이다. 트리를 두 벌 쓰면 §1의 첫 번째 요구가 깨진다.

### 해결: 지시어 없는 트리 + 경계 심(shim)

RSC에서 `'use client'` 없는 모듈은 **임포트하는 쪽의 그래프를 따른다.** 서버 컴포넌트가 임포트하면 서버 컴포넌트로, 클라이언트 컴포넌트가 임포트하면 클라이언트 번들로 들어간다. 이 성질을 이용한다.

```
components/
  leaves/            지시어 없음 — 두 그래프 모두에서 사용 가능
  widgets/           'use client' — 인터랙티브, Islands의 섬
  trees/
    ContentTree.tsx        지시어 없음 — 서버 그래프 진입점 (islands)
    ContentTree.client.tsx 'use client' 경계 심 (csr/ssr/stream/ssg)
```

```tsx
// components/trees/ContentTree.client.tsx — 전부 3줄
'use client'
export { ContentTree as default } from './ContentTree'
```

**트리 정의는 한 벌이고, 3줄짜리 심이 그것을 클라이언트 그래프로 끌어올린다.** 리프 컴포넌트는 지시어가 없으므로 양쪽에서 그대로 재사용된다.

제약: 리프와 트리는 서버 전용 API(`fs`, DB 드라이버)를 쓸 수 없고 `async`일 수 없다. 데이터는 전부 props로 내려오므로 실제 문제는 없다.

### 모드별 진입점

```tsx
// lib/render/renderFor.tsx
export function renderFor(mode: Mode, type: RouteType) {
  return async function Page({ params }) {
    const route = resolveRoute(type, params)

    switch (mode) {
      case 'csr':
        return <ClientRoot route={route} />                    // 셸만, 데이터는 클라이언트가 fetch

      case 'ssr': case 'ssg':
        return <ClientTree type={type} data={await getData(route)} />

      case 'stream':
        return <StreamShell route={route}>                     {/* 셸 즉시 flush */}
                 <Suspense fallback={<Skeleton type={type} />}>
                   <AsyncClientTree route={route} />           {/* 데이터 준비되면 청크 */}
                 </Suspense>
               </StreamShell>

      case 'islands':
        return <ServerTree type={type} data={await getData(route)} />   // 위젯만 하이드레이션
    }
  }
}
```

### 의도적으로 없애지 않을 것

측정 타당성을 위해 남겨야 하는 "비효율"이 있다. 최적화하고 싶은 충동을 눌러야 한다.

- **SSR·SSG의 데이터 이중 전송.** 서버가 HTML을 그리고, 하이드레이션을 위해 같은 데이터를 직렬화해 또 보낸다. SSR 계열의 실제 비용이다.
- **CSR의 추가 왕복.** 셸 → JS → API fetch로 최소 3 RTT. 저대역·고RTT에서 CSR이 불리해지는 주된 이유이고 **곧 결정 경계 그 자체**다. API를 인위적으로 빠르게 만들면 연구 대상이 사라진다.
- **Islands도 RSC 페이로드를 보낸다.** JS 번들은 작지만 flight data는 그대로 전송된다. 순수 이득이 아니며, 이 트레이드오프가 측정 대상이다.
- **SSR도 JS를 보낸다.** 하이드레이션 때문에 번들 크기는 CSR과 거의 같다. 저사양 기기에서 SSR의 이점이 깎이는 이유다.

---

## 4. 행동 공간은 라우트마다 다르다

제안서 §3.1은 행동 공간을 `M = {CSR, SSR, Streaming SSR, SSG·ISR, Islands}`로 정의하지만, §3.5의 하드 규칙과 합치면 **실제 후보는 라우트에 따라 부분집합**이 된다.

```
M(route) ⊆ M
```

| 배제 규칙 | 근거 |
|---|---|
| `personalizedRatio > 0` → SSG·ISR 배제 | 사용자별 데이터를 정적 캐시로 내보내는 것은 애초에 유효한 선택지가 아니다 |
| 결제·인증 라우트 → SSR 고정 | 정합성 리스크를 모델에 위임하지 않음 |
| 크롤러 UA → SSR 고정 | SEO 리스크를 모델에 위임하지 않음 |
| `freshnessMs < revalidate` → SSG·ISR 배제 | 요구 신선도를 못 맞추는 모드는 후보가 아니다 |

**이걸 빼먹으면 데이터셋이 오염된다.** SSG는 요청당 서버 CPU가 거의 0이라 목적함수에서 거의 항상 이긴다. 개인화 라우트에서 SSG를 후보로 남겨두면 모델은 "항상 SSG"를 학습하고, 그 정책은 배포 즉시 잘못된 콘텐츠를 서빙한다.

factorial 수집 시에도 배제된 셀은 **아예 측정하지 않는다.** 측정해서 나중에 거르는 게 아니라, 그리드 정의에서 빠진다. 10,000셀은 이 배제를 반영한 뒤의 수다.

```ts
// lib/routes.ts
export function candidateModes(route: Route): Mode[] {
  let m: Mode[] = ['csr', 'ssr', 'stream', 'islands']
  if (route.personalizedRatio === 0 && route.freshnessMs >= REVALIDATE_MS) m.push('ssg')
  if (route.hardPinned) return ['ssr']
  return m
}
```

---

## 5. 라우트 25종

유형 5종 × 인스턴스 5개. 유형은 **서로 다른 축에서 무겁도록** 배정하고, 인스턴스는 그 축 위에서 값을 흩뿌려 결정 경계가 격자에 걸리게 한다.

| 유형 | 지배 요인 | SEO | 개인화 | SSG 가능 | 예상 우세 모드 |
|---|---|---|---|---|---|
| **콘텐츠형** | 전송 바이트 | 필수 | 없음 | ○ | SSG·ISR |
| **목록형** | DOM 노드 수 | 중요 | 낮음 | 부분 | SSG / Streaming |
| **대시보드형** | 하이드레이션 CPU | 무관 | 높음 | × | CSR / Islands |
| **폼형** | 인터랙션 준비(INP) | 낮음 | 중간 | × | Islands |
| **개인화형** | 캐시 불가 + 서버 부하 | 무관 | 최대 | × | 부하 의존 |

### 유형별 파라미터

```
콘텐츠형    nodeCount 2500  interactive 2   payloadKB 120  fetchDepth 1  personalized 0.0
목록형      nodeCount 5000  interactive 6   payloadKB 150  fetchDepth 1  personalized 0.1
대시보드형  nodeCount 4000  interactive 24  payloadKB  60  fetchDepth 3  personalized 0.8
폼형        nodeCount 1200  interactive 18  payloadKB  30  fetchDepth 1  personalized 0.4
개인화형    nodeCount 3000  interactive 10  payloadKB  90  fetchDepth 2  personalized 1.0
```

인스턴스 5개는 이 기준값 주위에서 **가장 지배적인 축만** ±60% 범위로 흩뿌린다. 모든 축을 동시에 흔들면 어떤 축이 결정을 갈랐는지 사후에 분리할 수 없다.

### 예상 우열은 가설이지 목표가 아니다

측정 결과가 표와 다르면 표를 고치는 것이지 앱을 고치는 게 아니다. 다만 **25개 라우트가 전부 같은 모드를 선호한다면** 그건 앱이 축을 분리하지 못한 것이므로, 그때는 파라미터를 재조정해야 한다. 이 확인이 §12의 3단계 검증이다.

---

## 6. 데이터 계층

5개 모드가 같은 데이터를 서로 다른 경로로 가져와야 한다. 경로마다 코드가 다르면 페이로드가 미세하게 갈라져 비교가 오염된다. **단일 함수 + 전송로 두 개**로 해결한다.

```ts
// lib/data/index.ts
export async function getData(route: Route): Promise<Payload>
```

```ts
// app/api/data/[type]/[key]/route.ts — CSR 전용 전송로
export async function GET(_req, { params }) {
  return Response.json(await getData(params))    // 동일 함수, HTTP 껍데기만 추가
}
```

개인화 라우트는 페이로드를 `shared`(캐시 가능)와 `personalized`(캐시 불가)로 분리해 각각 다른 캐시 정책을 태운다. 이 분리가 없으면 ISR의 부분 캐시 효과를 측정할 수 없다.

### 결정성

`Math.random()`, `Date.now()`, 실제 DB 금지. 라우트 키를 시드로 하는 PRNG로 고정 코퍼스에서 생성한다.

```ts
const rng = seeded(hash(route.type + route.key))   // 같은 라우트 → 항상 같은 바이트
```

이미지는 크기가 고정된 로컬 에셋만 쓴다. 외부 CDN·랜덤 플레이스홀더는 페이로드 크기와 지연을 흔들어 노이즈가 된다.

### 비용 노브

| 노브 | 범위 | 영향 |
|---|---|---|
| `fetchDelayMs` | 0 / 50 / 200 | 백엔드 의존성 지연. SSR·Streaming의 TTFB에 직격 |
| `fetchDepth` | 1~3 | 순차 의존 fetch. CSR은 왕복이 누적 |
| `payloadKB` | 30~200 | 전송 바이트. 저대역에서 지배적 |
| `nodeCount` | 1200~5000 | DOM 노드. 서버·클라이언트 렌더 CPU 양쪽 |
| `interactiveCount` | 2~24 | 하이드레이션 대상. Islands의 이득 폭을 결정 |
| `personalizedRatio` | 0~1 | 캐시 가능 비율. SSG 후보 여부를 가름 |
| `freshnessMs` | 0~3600000 | 요구 신선도. ISR revalidate와 비교 |

---

## 7. 계측

### 상관 ID — 데이터 무결성의 급소

렌더 결정은 결정 계층에서, 성능 측정은 브라우저에서 일어난다. 이 둘을 잇지 못하면 데이터셋이 통째로 쓸모없어진다.

```
결정 계층이 cid 생성 + 피처 스냅샷 기록
  → 내부 경로로 재작성하며 헤더 전달
  → 앱이 서버 측 레코드(모드, CPU 시간, 캐시 상태)를 cid로 기록
  → 앱이 HTML <head> 최상단에 cid 인라인 주입
  → 클라이언트 비콘이 web-vitals와 함께 cid로 전송
  → 데이터 레이크에서 cid로 조인
```

```tsx
// app/__m/layout.tsx
<script id="__exp" type="application/json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({ cid, mode, cell, route }) }} />
```

`<head>` 최상단이어야 한다. 문서 하단에 두면 LCP 이전에 발생한 비콘이 cid를 못 읽는 경우가 생긴다. **Streaming SSR에서 특히 중요하다** — 첫 청크에 들어가지 않으면 셸만 받은 시점의 측정이 고아가 된다.

### 랩 지표와 필드 지표

제안서 §3.1의 QoE는 `{LCP, INP, TBT, TTFB}`인데 TBT는 랩 전용 지표다.

| 지표 | 랩 | 필드 | 수집 |
|---|---|---|---|
| LCP · TTFB · CLS | ○ | ○ | `web-vitals/attribution` |
| INP | ○ | ○ | `web-vitals` (상호작용 필요 → 워커가 스크립트 상호작용 주입) |
| TBT | ○ | × | `PerformanceObserver('longtask')` 합산 |

`attribution` 빌드를 쓰는 이유: LCP가 느릴 때 원인이 TTFB인지 리소스 로드인지 렌더 지연인지 분해된다. **모드 간 차이가 어디서 생기는지**가 세그먼트 분석의 핵심이라 이 분해가 필요하다.

INP는 자연 발생하지 않으므로 워커가 결정적 상호작용 시퀀스(클릭·입력·스크롤)를 주입한다. 시퀀스는 라우트 유형별로 고정하고 시드로 관리한다.

### 서버 비용 — 주의 필요

```ts
const t0 = process.cpuUsage()
const html = await render()
const used = process.cpuUsage(t0)     // µs 델타
```

**이 값은 배경 부하가 있으면 오염된다.** `process.cpuUsage()`는 프로세스 전체 값이고 k6 부하가 같은 프로세스에서 동시 처리되므로 델타에 남의 작업이 섞인다. 부하가 높을수록 오차가 커진다.

두 지표를 함께 기록하고 용도를 나눈다.

| 지표 | 측정법 | 용도 |
|---|---|---|
| 순수 렌더 CPU | Idle 셀에서만 per-request 델타 | 모드별 고유 비용 비교 |
| 실효 CPU/요청 | 부하 구간의 총 CPU ÷ 처리 요청 수 | 목적함수의 자원 항 |

이벤트 루프 지연은 `perf_hooks.monitorEventLoopDelay()`로 상시 수집한다. 프로세스 단위 지표라 오염 문제가 없고, "렌더 큐 지연" 피처의 실체가 된다.

### 서버 상태 스냅샷

```
GET /api/_internal/metrics
  → { cpuPct, memPct, inflight, eventLoopP95Ms, renderQueueDepth, cacheHitRate, ts }
```

결정 계층이 30초 주기로 캐시해 쓴다. 요청마다 조회하면 그 왕복이 TTFB에 얹혀 측정 대상을 왜곡한다(제안서 §6.7).

### 세션 프로파일 — 콜드 스타트 대응

최초 요청에는 Client Hints가 없다. 앱은 응답 시 실측 RUM 요약을 쿠키에 기록해 다음 요청부터 정밀 피처가 쓰이게 한다.

```
Set-Cookie: __prof=<base64({lcpP50, tbtP50, deviceMemory, hc})>; Max-Age=…
```

### 가드레일 지표

제안서 §3.5의 안전장치가 작동하는지 확인하려면 앱이 아래를 내보내야 한다.

- 하이드레이션 오류율 — 루트 에러 바운더리에서 비콘 전송
- 모드 전환 빈도 — 세션당 전환 횟수(상한 1회)
- 캐시 적중률 — `x-cache-status` 집계

---

## 8. ServerCost 정의 문제 — SSG가 부당하게 이긴다

제안서 §3.1은 `ServerCost`를 "요청당 렌더링 CPU 시간"으로 정의한다. **이 정의를 그대로 쓰면 SSG·ISR이 거의 항상 이긴다.** 캐시 히트 시 렌더 CPU가 0이기 때문이다.

하지만 SSG는 비용을 없앤 게 아니라 **빌드·재검증 시점으로 옮긴** 것이다. 공정하게 비교하려면 amortize해야 한다.

```
ServerCost(ssg) = 렌더 1회 CPU / (revalidate 주기 동안의 요청 수)
```

즉 트래픽이 많을수록 SSG가 유리해지고, 트래픽이 희박하면 이점이 사라진다. 이 관계 자체가 흥미로운 결과이므로 **요청률을 피처로 넣어야** 모델이 학습할 수 있다.

| 항목 | 처리 |
|---|---|
| 캐시 히트 | `ServerCost = 0`이 아니라 amortized 값 |
| 캐시 미스·stale | 실제 렌더 CPU 전액 |
| 요청률 | 서버 상태 스냅샷에 `rps`를 추가해 피처화 |

`x-cache-status`를 반드시 기록해야 이 계산이 가능하다. 이것이 §2 응답 헤더에 그 필드가 있는 이유다.

---

## 9. 디렉토리 구조

```
03_Project/
├── apps/benchmark/                    SUT — Next.js 앱
│   ├── app/
│   │   ├── __m/                       모드별 진입점 (5모드 × 5유형 = 25 파일, 각 5줄)
│   │   │   ├── layout.tsx             상관 ID 주입, 비콘 부트스트랩
│   │   │   ├── csr/{content,list,dashboard,form,personalized}/[key]/page.tsx
│   │   │   ├── ssr/…  stream/…  ssg/…  islands/…
│   │   └── api/
│   │       ├── data/[type]/[key]/route.ts     CSR 전송로
│   │       ├── beacon/route.ts                RUM 수집
│   │       └── _internal/metrics/route.ts     서버 상태 스냅샷
│   ├── components/
│   │   ├── leaves/                    지시어 없음 — 두 그래프 공용
│   │   ├── widgets/                   'use client' — Islands의 섬
│   │   └── trees/                     유형별 트리 + 3줄 경계 심
│   └── lib/
│       ├── render/renderFor.tsx       모드별 진입점 팩토리
│       ├── data/                      결정적 생성기 (시드 고정)
│       ├── instrument/                상관 ID, CPU 시간, 비콘, 세션 프로파일
│       └── routes.ts                  라우트 25종 정의 + 후보 모드 산출
├── policy/                            결정 계층 — 정책 교체 가능
├── workers/                           Playwright 측정 워커 (상호작용 시퀀스 포함)
├── load/                              k6 배경 부하 스크립트
├── infra/                             AWS CDK
└── docs/                              이 문서
```

### 결정 계층의 정책 교체

실험군 전체가 같은 코드 경로를 타야 정책 간 비교가 공정하다.

```ts
type Policy = (f: Features, cands: Mode[]) => Mode

const POLICIES = {
  'fixed-csr':    (_, c) => pick(c, 'csr'),
  'fixed-ssr':    (_, c) => pick(c, 'ssr'),
  'fixed-stream': (_, c) => pick(c, 'stream'),
  'fixed-ssg':    (_, c) => pick(c, 'ssg'),
  'rule-based':   (f, c) => (f.deviceTier <= 2 || f.effectiveType === '3g' || f.cpuPct > 80)
                              ? pick(c, 'ssr') : pick(c, 'csr'),
  'surrogate':    (f, c) => argmin(c, m => tree.eval(f, m)),      // 증류 트리
  'forced':       (f, c) => f.forcedMode,                          // factorial 수집용
}
```

고정 정책도 `candidateModes`를 존중해야 한다. 개인화 라우트에서 `fixed-ssg`는 성립하지 않으므로 `pick`이 폴백(Streaming SSR)으로 떨어진다. 이 폴백 발생을 로그에 남겨야 비교 결과를 해석할 수 있다.

### 마진 기반 폴백

```ts
const scores = cands.map(m => ({ m, j: tree.eval(f, m) })).sort((a,b) => a.j - b.j)
if (scores[1].j - scores[0].j < TAU) return 'stream'   // 차이가 작으면 전환 안 함
return scores[0].m
```

`TAU`는 전환 고정비(캐시 파편화)의 추정값이고, 실험 파라미터로 다룬다.

---

## 10. 라우트 정적 특징 테이블

라우트 특성 피처를 요청마다 계산하면 안 된다(그 계산이 곧 오버헤드). 빌드 후 한 번 산출해 룩업 테이블로 만든다.

```
npm run analyze:routes    →  lib/routes.generated.json
```

| 특징 | 산출 방법 |
|---|---|
| 예상 DOM 노드 수 | 라우트 정의의 `nodeCount` |
| 라우트 JS 번들 크기 | Next.js 빌드 매니페스트에서 **모드별로** 추출 |
| 인터랙티브 컴포넌트 수 | 트리 정의의 위젯 수 |
| 데이터 fetch depth | 라우트 정의의 `fetchDepth` |
| 개인화 여부 | `personalizedRatio > 0` |
| SEO 중요도 | 라우트 정의의 수동 지정값 |
| 후보 모드 집합 | `candidateModes(route)` (§4) |

번들 크기는 **모드별로** 달라진다 — Islands는 위젯만, 나머지는 트리 전체가 클라이언트 번들에 들어간다. 이 차이가 Islands의 주된 이득이므로 단일 값으로 뭉뚱그리면 안 된다.

---

## 11. 측정 함정

구현 중 어기기 쉬운 것들. 어기면 데이터가 조용히 오염된다.

1. **프로덕션 빌드 필수.** dev 서버는 요청 시 컴파일하므로 첫 요청이 수 초 걸린다. `next build && next start`로만 측정한다.
2. **워밍업 3회.** JIT·커넥션 풀·라우트 캐시 안정화 후 측정 시작.
3. **SSG 캐시 상태를 명시적으로 통제.** ISR은 첫 요청이 미스, 이후 히트, `revalidate` 경과 후 stale이다. **셀 정의에 캐시 상태를 변수로 넣지 않으면 같은 셀에서 히트와 미스가 섞여 분산이 폭발한다.**
4. **콜드/웜 브라우저 고정.** 반복마다 프로필 초기화.
5. **모드 실행 순서 무작위화.** 5개 모드를 무작위 순서로 실행한다. 순차 실행하면 인프라 드리프트가 특정 모드에 체계적으로 몰린다.
6. **부하 셀과 측정 셀 분리.** k6는 실제 렌더를 하지 않으므로 k6 값으로 Web Vitals를 계산하면 안 된다.
7. **모드 간 번들 동일성 검증.** CSR·SSR·Streaming·SSG는 같은 클라이언트 번들을 써야 한다. 경로가 다르면 Next.js가 다른 청크를 낼 수 있으므로 빌드 산출물을 비교 검증한다. Islands만 달라야 정상이다.
8. **버전 기록.** Chrome·Playwright·Node·Next.js 버전을 모든 실험 레코드에 넣는다. 브라우저 업데이트만으로 성능 특성이 바뀐다.
9. **Streaming의 측정 종료 시점.** 스트리밍은 응답이 여러 청크로 나뉘므로 "언로드 시점 수집"이 아니라 마지막 청크 도착 후 안정화까지 기다려야 LCP가 확정된다.

---

## 12. 구현 순서

각 단계는 다음 단계의 전제를 검증한다. 순서를 건너뛰면 나중에 데이터를 버리게 된다.

| 단계 | 내용 | 검증 |
|---|---|---|
| 1 | 골격 — 라우트 정의, 결정적 생성기, 콘텐츠형 1종 × 5모드 | 5개 모드의 최종 DOM이 동일한가 |
| 2 | 계측 — 상관 ID, 비콘, CPU 시간, 캐시 상태 | 서버 레코드와 클라이언트 비콘이 100% 조인되는가 |
| 3 | 유형 확대 — 5유형 × 5인스턴스 = 25 라우트 | **유형별 모드 우열이 서로 다른 방향인가** (§5) |
| 4 | 결정 계층 — 프록시, 정책 플러그인, 후보 모드 배제, 마진 폴백 | 정책 교체가 앱 코드에 영향을 주지 않는가 / 추론 오버헤드 < 2ms인가 |
| 5 | 부하·측정 워커 — k6 캘리브레이션, Playwright, 상호작용 시퀀스 | 반복 30회의 분산이 모드 간 차이보다 작은가 |

3단계에서 모든 유형이 같은 모드를 선호하면 §5의 파라미터를 재조정한다. 5단계 검증이 통과하지 못하면 **factorial 수집을 시작해선 안 된다.** 노이즈가 신호보다 크면 10,000셀을 모아도 결정 경계가 나오지 않는다.
