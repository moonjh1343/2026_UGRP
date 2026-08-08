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
내부 경로         /m/ssg/content/deep-dive-01
```

> **경로 이름 주의.** App Router는 밑줄로 시작하는 폴더(`_m`, `__m`)를 **private 폴더로 보고 라우팅에서 제외**한다. 설계 초안의 `__m/`은 동작하지 않아 `m/`으로 확정했다.

```
app/m/csr/content/[slug]/page.tsx        dynamic = 'force-dynamic'
app/m/ssr/content/[slug]/page.tsx        dynamic = 'force-dynamic'
app/m/stream/content/[slug]/page.tsx     dynamic = 'force-dynamic'
app/m/ssg/content/[slug]/page.tsx        dynamic = 'force-static', revalidate = 60
app/m/islands/content/[slug]/page.tsx    dynamic = 'force-dynamic'
```

각 파일은 공유 렌더러에 위임하는 5줄짜리 껍데기다. 파일 수는 5모드 × 5유형 = **25개**이고, 라우트 25종은 `[slug]` 파라미터로 표현되므로 파일이 늘지 않는다.

```tsx
// app/m/ssg/content/[slug]/page.tsx
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
import { ContentTree } from './ContentTree'
export default ContentTree
```

**트리 정의는 한 벌이고, 3줄짜리 심이 그것을 클라이언트 그래프로 끌어올린다.** 리프 컴포넌트는 지시어가 없으므로 양쪽에서 그대로 재사용된다.

> **모드별 렌더 모듈을 분리해야 한다 — 1단계에서 확인된 함정.**
> 모드 분기를 `renderFor(mode, type)` 하나의 공용 모듈에 두면, 그 모듈이 `ContentTree.client`를
> 임포트하는 순간 **Islands 라우트의 클라이언트 번들에도 트리가 끌려 들어간다.** 임포트 그래프는
> switch 문의 분기를 따라가지 않기 때문이다. 실제로 첫 구현에서 Islands의 JS 절감이 정확히
> 0%였고, `lib/render/{csr,hydrated,stream,islands}.tsx`로 쪼갠 뒤에야 트리가 서버 그래프에 남았다.
> 공용 모듈(`shell.tsx`)은 라우트 해석과 `M(r)` 검증만 담당하고 **트리를 임포트하지 않는다.**

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

> 제안서 §3.1.1에 반영됨. 이 절은 그 제약을 앱에서 구현하는 방법이다.

**실제 후보는 라우트에 따라 부분집합**이다.

```
M(route) ⊆ M
```

| 배제 규칙 | 근거 |
|---|---|
| `personalizedRatio > 0.2` → SSG·ISR 배제 | 사용자별 데이터를 정적 캐시로 내보내는 것은 애초에 유효한 선택지가 아니다. 임계값 아래(목록형 등)는 공용 페이로드만 ISR로 캐시하는 하이브리드가 성립 |
| 결제·인증 라우트 → SSR 고정 | 정합성 리스크를 모델에 위임하지 않음 |
| 크롤러 UA → SSR 고정 | SEO 리스크를 모델에 위임하지 않음 |
| `freshnessMs < revalidate` → SSG·ISR 배제 | 요구 신선도를 못 맞추는 모드는 후보가 아니다 |

**이걸 빼먹으면 데이터셋이 오염된다.** SSG는 요청당 서버 CPU가 거의 0이라 목적함수에서 거의 항상 이긴다. 개인화 라우트에서 SSG를 후보로 남겨두면 모델은 "항상 SSG"를 학습하고, 그 정책은 배포 즉시 잘못된 콘텐츠를 서빙한다.

factorial 수집 시에도 배제된 셀은 **아예 측정하지 않는다.** 측정해서 나중에 거르는 게 아니라, 그리드 정의에서 빠진다. 10,000셀은 이 배제를 반영한 뒤의 수다.

```ts
// lib/routes.ts
export const THETA_P = 0.2                      // 제안서 §3.1.1

export function candidateModes(route: Route): Mode[] {
  if (route.hardPinned) return ['ssr']          // 결제·인증
  const m: Mode[] = ['csr', 'ssr', 'stream', 'islands']
  if (route.personalizedRatio <= THETA_P && route.freshnessMs >= REVALIDATE_MS) m.push('ssg')
  return m
}
```

---

## 5. 라우트 25종

유형 5종 × 인스턴스 5개. 유형은 **서로 다른 축에서 무겁도록** 배정하고, 인스턴스는 그 축 위에서 값을 흩뿌려 결정 경계가 격자에 걸리게 한다.

| 유형 | 지배 요인 | SEO | 개인화 | SSG 가능 | 예상 우세 모드 |
|---|---|---|---|---|---|
| **콘텐츠형** | 전송 바이트 | 필수 | 없음 | ○ | SSG·ISR |
| **목록형** | DOM 노드 수 | 중요 | 낮음 | ○ (ISR + 클라 개인화) | SSG / Streaming |
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

### 비용 노브는 데이터 무게만 바꾼다 — 3단계에서 해결

1단계에서 드러난 문제였다. 노브(`nodeCount`, `payloadKB`, `interactiveCount`)가 전부 **런타임 데이터**의 크기만 조절하고 **컴포넌트 코드** 크기는 바꾸지 않아, 라우트가 달라도 JS 번들이 거의 같았다.

3단계에서 유형별로 **실제로 무거운 컴포넌트 코드**를 도입해 해결했다.

| 유형 | 코드 무게의 원천 |
|---|---|
| 대시보드형 | `lib/chart/scale.ts` — 스케일·눈금·Catmull-Rom 경로 계산. 하이드레이션마다 클라이언트에서 재실행된다 |
| 폼형 | `FormField` — 필드별 정규식 컴파일과 입력마다의 검증 |
| 목록형 | 항목 수가 곧 DOM 노드 수 |

이 계산이 **하이드레이션 시점에 클라이언트에서 다시 실행된다**는 점이 핵심이다. SSR은 서버에서 그린 것을 클라이언트에서 반복하므로 비용을 두 번 내고, Islands는 트리를 서버에 남겨 이를 피한다.

### 인스턴스 포화 — 생성기 클램프가 확산 상단을 자른다

3단계에서 발견했다. 인스턴스는 지배 축을 ±60%로 흩뿌리지만, 생성기 내부의 `clamp` 상한이 낮으면 상단 인스턴스들이 **같은 페이로드로 붕괴**한다.

- `wordsPerUnit`의 상한 400 → `content-04`와 `content-05`가 둘 다 111KB
- `list`의 `itemCount` 상한 400 → `list-04`와 `list-05`가 둘 다 400항목
- `form`의 `perSection = round(fieldCount / sectionCount)` → 13개와 18개가 둘 다 16필드

유형당 5개 중 2개를 잃으면 그리드 커버리지가 조용히 줄어든다. `npm run check:determinism`이 인접 인스턴스의 페이로드 차이가 2% 미만이면 실패시켜 재발을 막는다. 지배 축이 지연(`fetchDelayMs`)인 개인화형처럼 페이로드가 같은 것이 정상인 유형은 검사에서 제외한다.

### 3단계 실측 결과 — 가설은 절반만 맞았다

CPU 4× 스로틀 · 3G Fast · 반복 8회 중앙값. 대표 인스턴스(각 유형 3번)로 측정했다.

| 유형 | 최우수 | 가설 | 결과 |
|---|---|---|---|
| 콘텐츠형 | SSG·ISR | SSG·ISR | 일치, 큰 폭 |
| 목록형 | SSG·ISR | SSG / Streaming | 대체로 일치 |
| 대시보드형 | Islands | CSR / Islands | Islands 일치, **CSR은 최하위** |
| 폼형 | Streaming | Islands | 불일치 (상위 3개가 동률) |
| 개인화형 | SSR | 부하 의존 | 무부하 조건이라 판단 보류 |

**CSR이 모든 유형에서 명확히 최하위였다.** 3G Fast에서 셸 → JS → API fetch의 추가 왕복이 지배적이어서, 하이드레이션 비용의 이점을 전부 상쇄한다. 대시보드형에서 CSR이 유리할 것이라는 가설은 **네트워크가 좋은 조건에서만** 성립할 가능성이 크다 — 기기·네트워크 격자를 넓혀야 확인된다.

**상위 모드 간 차이가 노이즈 수준인 유형이 셋이다**(대시보드 864 vs 867, 폼 709 vs 724, 개인화 734 vs 737). 이는 제안서 §3.5의 마진 기반 폴백이 장식이 아니라 **실질적으로 필요하다**는 증거다. 전환에는 캐시 파편화라는 고정 비용이 있으므로, 이 구간에서는 "전환하지 않음"이 옳은 판단이다.

> **반복 수.** n=3에서는 순위가 실행마다 뒤집혔다(콘텐츠형이 ssr↔stream↔ssg). n=8에서 안정됐다. 제안서 §5.2가 셀당 30회를 규정하는 이유가 여기서 실증된다.

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
결정 계층(미들웨어)이 cid 생성 + 피처 스냅샷 기록
  → 내부 경로로 재작성하며 요청 헤더로 전달
  → 앱이 서버 측 레코드(모드, CPU 시간)를 cid로 기록
  → 응답에 Server-Timing 헤더로 cid 부착
  → 클라이언트 비콘이 PerformanceServerTiming에서 cid를 읽어 web-vitals와 함께 전송
  → 데이터 레이크에서 cid로 조인
```

#### HTML 인라인 주입이 아니라 Server-Timing 헤더를 쓴다

초안은 cid를 `<head>`에 `<script type="application/json">`으로 심는 방식이었다. **SSG·ISR에서 성립하지 않는다** — 페이지가 요청 **전에** 렌더되므로 본문에 요청별 값을 넣을 수 없다.

응답 헤더는 캐시된 본문에도 요청마다 새로 붙고, 표준 API로 브라우저 JS에서 읽힌다.

```ts
const nav = performance.getEntriesByType('navigation')[0]
const cid = nav.serverTiming.find((e) => e.name === 'cid')?.description
```

이 방식이 5개 모드 전부에서 균일하게 동작한다(1단계 환경에서 SSG 캐시 히트 포함 검증). 부수 효과로 HTML을 건드리지 않으므로 모드 간 DOM 동등성 검증에도 영향이 없다.

> **응답 헤더를 서버 컴포넌트에서 설정할 수 없다.** 따라서 초안의 `x-server-cpu-us`는 구현 불가다. 렌더 비용은 헤더가 아니라 **레코드 스트림으로 직접** 보낸다. 클라이언트는 이 값을 알 필요가 없고 조인은 데이터 레이크에서 일어나므로 실제 손실은 없다.

#### CSR은 상관 ID를 데이터 요청에 전파해야 한다

CSR의 서버 비용은 셸 렌더와 `/api/data` 호출로 나뉜다. API 요청은 별개 요청이라 미들웨어에서 **새 cid를 받는다.** 전파하지 않으면 한 페이지뷰의 서버 비용이 두 cid로 흩어져 조인이 끊긴다. 클라이언트가 페이지 cid를 헤더로 실어 보내고, 미들웨어는 기존 cid가 있으면 존중한다.

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

**문제 1 — 해상도.** `process.cpuUsage()`의 정밀도는 플랫폼 타이머에 묶여 있다. Windows에서는 15.625ms 단위로 양자화되어 **수 ms짜리 렌더가 전부 0으로 잡힌다**(2단계 실측: 렌더 wall 1.4~5.6ms, cpuUs는 0 또는 16000). Linux는 `getrusage` 기반이라 훨씬 정밀하지만, 밀리초 미만 렌더는 여전히 노이즈 바닥에 가깝다.

따라서 **per-request CPU 값은 진단용일 뿐 지표가 아니다.** `C_render(m)`은 N회 반복의 총 CPU를 N으로 나눠 구한다. 제안서 §5.2가 셀당 30회 반복을 규정하는 것과 같은 이유다. 2단계 실측에서 N=60은 순서가 뒤집힐 만큼 불안정했고 N=300에서야 정합적인 값이 나왔다(SSR 1923µs ≈ Streaming 1933µs — 같은 렌더 경로라는 기대와 일치).

**문제 2 — 오염.** `process.cpuUsage()`는 프로세스 전체 값이고 k6 부하가 같은 프로세스에서 동시 처리되므로 델타에 남의 작업이 섞인다. 부하가 높을수록 오차가 커진다.

두 지표를 함께 기록하고 용도를 나눈다.

| 지표 | 측정법 | 용도 |
|---|---|---|
| `C_render(m)` | Idle 셀에서 N회 반복의 총 CPU ÷ N | 모드별 고유 비용 (§3.1.2) |
| 실효 CPU/요청 | 부하 구간의 총 CPU ÷ 처리 요청 수 | 목적함수의 자원 항 |
| per-request wall | 렌더 구간 벽시계 시간 | 진단·이상치 탐지 |

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

## 8. ServerCost 측정 요구사항

> 제안서 §3.1.2에 반영됨. 이 절은 앱이 무엇을 내보내야 그 계산이 가능한지를 정리한다.

제안서의 환산 정의는 다음과 같다.

```
ServerCost(x, m) = C_render(m) × missRate(x, m) + C_serve(m) + μ × C_store(m)
missRate(x, ssg) = 1 / max(1, rps_r × T)
```

앱이 이 값을 계산 가능하게 하려면 아래를 내보내야 한다.

| 필요한 값 | 앱의 책임 |
|---|---|
| `missRate` | 응답에 `x-cache-status: hit \| miss \| stale` (§2) |
| `C_render(m)` | Idle 셀에서 per-request CPU 델타 (§7) |
| `C_serve(m)` | 캐시 히트 응답에서도 CPU 델타 기록 |
| `rps_r` | 서버 상태 스냅샷에 **라우트별** 요청률 — 전역 rps로는 라우트별 캐시 효율을 반영 못 함 |
| `C_store(m)` | 모드별 캐시 엔트리 크기 |

랩 실험에서는 `rps_r`이 k6 부하로 통제되므로 알려진 값이다. 셀 정의에 포함시켜 기록한다.

---

## 9. 디렉토리 구조

```
03_Project/
├── apps/benchmark/                    SUT — Next.js 앱
│   ├── app/
│   │   ├── m/                         모드별 진입점 (5모드 × 5유형 = 25 파일, 각 5줄)
│   │   │   ├── csr/{content,list,dashboard,form,personalized}/[slug]/page.tsx
│   │   │   ├── ssr/…  stream/…  ssg/…  islands/…
│   │   └── api/
│   │       ├── data/[type]/[key]/route.ts     CSR 전송로
│   │       ├── beacon/route.ts                RUM 수집
│   │       └── internal/{metrics,routes,records,policy}/  계측 도구 (5단계에서 제거)
│   ├── components/
│   │   ├── leaves/                    지시어 없음 — 두 그래프 공용
│   │   ├── widgets/                   'use client' — Islands의 섬
│   │   └── trees/                     유형별 트리 + 3줄 경계 심
│   ├── lib/
│   │   ├── render/<mode>.tsx          모드별 렌더 — 트리를 인자로 받는다
│   │   ├── render/shell.tsx           공용 — 트리를 임포트하지 않는다
│   │   ├── data/                      결정적 생성기 (시드 고정)
│   │   ├── instrument/                상관 ID, CPU 시간, 비콘, 서버 상태
│   │   └── routes.ts                  라우트 25종 정의 + 후보 모드 산출
│   ├── policy/                        결정 계층 (아래)
│   └── middleware.ts                  결정 계층의 실행 지점
├── workers/                           Playwright 측정 워커 (상호작용 시퀀스 포함)
├── load/                              k6 배경 부하 스크립트
├── infra/                             AWS CDK
└── docs/                              이 문서
```

> **`policy/`의 위치가 초안과 다르다.** 설계 초안은 `03_Project/policy/`(앱과 형제)로 두었다.
> 실제로는 `apps/benchmark/policy/`에 두었는데, 미들웨어가 임포트해야 하고 Turbopack의
> 워크스페이스 루트가 lock 파일 위치(=앱 디렉토리)로 잡히기 때문이다. 분리의 **목적**인
> "앱과의 무결합"은 위치가 아니라 임포트 방향으로 강제한다 — `check:policy`의 A절이
> 앱 렌더 경로의 `@/policy` 임포트와 `policy/`의 `node:*`·앱 임포트를 둘 다 금지한다.
> 후자는 Lambda@Edge 이식성 조건이기도 하다.

### 결정 계층의 구조

```
policy/
  index.ts        decide() — 가드 체인. 정책은 여기를 통과해야 적용된다
  policies.ts     POLICIES 맵 (fixed-* 5종, rule-based, surrogate)
  surrogate.ts    증류 트리 평가기 — argmin over M(x)
  model/tree.v0.json   깊이 5 트리
  features.ts     헤더·쿠키 → Features, 그리고 트리 입력 벡터
  routeTable.ts   라우트 정적 특징 룩업 (모듈 초기화 시 1회)
  serverState.ts  서버 상태 30초 캐시 — 절대 await 하지 않는다
  session.ts      세션·라우트별 결정 쿠키 (전환 상한)
  config.ts       τ, TTL, 서킷 브레이커 임계값 — 전부 환경변수로 덮인다
```

**가드 체인의 순서가 곧 우선순위다.**

```
forced → single → bot → circuit → policy → infeasible → margin → session-cap
```

정책은 "무엇을 고르고 싶은가"만 말하고, 실행 가능성·안전장치·전환 상한은 전부 `decide()`가
강제한다. 그래야 정책을 추가할 때 안전장치를 다시 구현하지 않아도 되고, 모든 실험군이
동일한 가드 체인을 통과한다.

`/m/…` 직접 요청은 정책을 **태우지 않는다.** factorial 수집은 동일 조건에서 5개 모드를
전부 찍어야 하므로 워커가 경로를 직접 지정하고, 그 경로에서 추론을 돌리는 것은 순수한
낭비다. 8,800셀 × 30회에 불필요한 추론이 얹히면 그 자체가 서버 부하 피처를 오염시킨다.

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

`TAU`는 전환 고정비(캐시 파편화)의 추정값이고, 실험 파라미터로 다룬다(`POLICY_TAU`).

기본값 0.05는 3단계 실측에서 나왔다. 대시보드·폼·개인화형은 상위 3개 모드가 측정 노이즈
안에 있었으므로, 그 폭보다 작은 예측 차로 모드를 바꾸는 것은 이득이 아니라 비용이다.
4단계 실행에서 실제로 폼형이 여기 걸려 `islands`(0.72) 대신 `stream`으로 폴백했다 —
2위 `ssr`(0.75)과의 차가 0.03이었다. **5단계 데이터로 재추정해야 하는 값이다.**

### 세션 전환 상한은 라우트 단위로 센다

제안서 §3.5는 "세션당 1회"라고 쓰지만, 구현에서는 (세션, 라우트) 쌍으로 센다.
한 세션이 여러 라우트를 방문하는 것은 정상이고 **라우트마다 최적 모드가 다르다는 것이
이 연구의 전제**이므로, 세션 전역으로 세면 첫 방문 라우트의 결정이 세션 내내 모든
라우트를 고정해 전제 자체를 부정하게 된다.

상태는 쿠키(`__dec`, `key:mode:n|…`)에 담는다. 엣지 아이솔레이트는 요청 간 상태를
공유하지 않고 DynamoDB 왕복은 TTFB에 얹히므로, 클라이언트가 들고 다니는 것이 가장 싸다.

---

## 10. 라우트 정적 특징 테이블

라우트 특성 피처를 요청마다 계산하면 안 된다(그 계산이 곧 오버헤드). 빌드 후 한 번 산출해 룩업 테이블로 만든다.

```
npm run analyze:routes    →  policy/bundles.generated.json   (→ npm run build 한 번 더)
```

**빌드 매니페스트를 파싱하지 않는다.** Next 16(Turbopack)에는 `app-build-manifest.json`이
없고, 있더라도 매니페스트는 청크 **목록**이지 전송 바이트가 아니다. 피처가 되어야 하는 것은
브라우저가 실제로 받는 양이므로, HTML의 `<script src>`를 따라가 바이트를 잰다.

닭-달걀 관계가 하나 남는다: 이 JSON은 엣지 번들에 정적 임포트되므로 **한 빌드 뒤처진**
값이 임베드된다. 엣지 런타임에는 파일 시스템이 없어 런타임 로드가 불가능하고, 번들 크기는
코드가 그대로면 재빌드해도 그대로라 대개 무시해도 된다. 값을 확정하려면 한 번 더 빌드한다.

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
7. **모드 간 번들 동일성 검증.** **SSR·Streaming·SSG** 세 모드는 같은 청크 집합을 써야 한다 — 셋 다 트리를 서버 렌더 후 전체 하이드레이션하므로 번들이 다르면 그 차이가 비교에 섞인다. CSR은 데이터 페처와 스켈레톤이 추가로 필요하므로 더 큰 것이 **정상**이고, 그 차이 자체가 CSR의 실제 비용이다. Islands는 트리가 빠져 더 작아야 한다. (`npm run report:bundles`)
8. **번들 크기가 아니라 그래프 내용으로 검증하라.** React·Next 런타임이 ~550KB를 차지해 앱 코드 차이가 총량에 묻힌다. 1단계 실측에서 Islands의 절감은 1.3KB(0.2%)에 불과했지만, 마커 문자열로 확인하니 트리와 리프는 실제로 클라이언트 그래프에서 빠져 있었다. 총량만 보면 기법이 실패한 것으로 오판한다. (`npm run inspect:graph`)
9. **DOM 비교 시 속성 순서를 정규화하라.** `innerHTML`은 속성의 **삽입 순서**를 보존하는데, 서버가 파싱한 HTML과 클라이언트가 `createElement`로 만든 요소는 그 순서가 다르다(SSR `<img src=… width=…>` vs CSR `<img width=… src=…>`). DOM 명세상 속성은 순서 없는 맵이므로 실제 차이가 아니다. 속성을 정렬한 정규형으로 비교해야 한다.
10. **버전 기록.** Chrome·Playwright·Node·Next.js 버전을 모든 실험 레코드에 넣는다. 브라우저 업데이트만으로 성능 특성이 바뀐다.
11. **Streaming의 측정 종료 시점.** 스트리밍은 응답이 여러 청크로 나뉘므로 "언로드 시점 수집"이 아니라 마지막 청크 도착 후 안정화까지 기다려야 LCP가 확정된다.
12. **밑줄로 시작하는 폴더는 라우팅에서 빠진다.** `app/__m/`뿐 아니라 `app/api/_internal/`도 마찬가지다 — 빌드는 성공하지만 라우트가 등록되지 않아 404가 난다. 빌드 출력의 라우트 목록에서 실제 등록 여부를 확인해야 조용히 넘어가지 않는다.
13. **per-request CPU를 지표로 쓰지 말 것.** 플랫폼 타이머 양자화로 0이 나온다(§7). `C_render`는 반복 집계로만 구한다.
14. **LCP·TBT를 `getEntriesByType`으로 읽지 말 것.** 롱태스크와 LCP는 `PerformanceObserver`(`buffered: true`) 없이는 타임라인에 남지 않아 전부 0/NaN이 나온다. 측정 스크립트가 직접 읽지 말고 앱의 비콘 파이프라인에서 조회한다.
15. **비콘 flush는 web-vitals의 확정 시점과 경쟁한다.** `onLCP`는 (첫 사용자 입력 | 페이지 숨김) 중 먼저 오는 시점에 확정하는데, 상호작용이 없는 페이지에서는 `visibilitychange`를 기다린다. 측정 워커가 다른 URL로 이동하면 `pagehide`만 발화하는 경우가 있어 LCP만 결측된다(3단계에서 폼형이 이렇게 누락됐다). 자체 LCP 관측자를 폴백으로 둔다.
16. **DOM 비교 시 폼 컨트롤은 라이브 프로퍼티로 비교한다.** React는 서버 렌더에서 `<option selected="">` 속성을 붙이고 클라이언트 렌더에서는 `select.value` 프로퍼티를 설정한다. 선택 상태는 같고 직렬화만 다르므로, 속성을 지우고 현재 `value`/`checked`를 기록해야 **구성 방식이 아니라 상태**를 비교하게 된다.
14. **세그먼트 설정은 리터럴이어야 한다.** Next.js는 `dynamic`·`revalidate`를 정적 분석하므로 `REVALIDATE_MS / 1000` 같은 계산식은 빌드를 깨뜨린다. 따라서 `revalidate` 값이 `lib/routes.ts`와 이중 관리되며, 어긋나면 SSG 후보 판정과 `missRate`의 `T`가 달라진다. 페이지 모듈에 단언을 넣어 드리프트를 빌드 시점에 잡는다.
15. **헤드리스 브라우저를 크롤러로 분류하지 말 것.** 봇 UA 패턴에 `headlesschrome`·`lighthouse`를 넣으면 **측정 워커 자신이 봇으로 잡혀** 모든 요청이 SSR로 하드핀된다. 정책이 실제로 무엇을 고르는지 영영 관측할 수 없고, 더 나쁘게는 검증이 "SSR vs SSR"을 비교하면서 통과한다. 4단계 첫 실행에서 실제로 이렇게 통과했다. 자기 신고형 크롤러(`bot`/`crawl`/`spider`)만 잡는다.
16. **서버 상태 조회를 결정 경로에서 await 하지 말 것.** `/api/internal/metrics`를 기다리면 그 왕복이 통째로 TTFB에 얹혀, 측정하려는 개선폭(수 ms)보다 큰 오염이 된다. 갱신은 백그라운드로 던지고 요청은 캐시된 값을 즉시 받는다. 단 부유 Promise로 두면 응답 반환 후 취소되어 캐시가 영영 비므로, `event.waitUntil`에 넘겨야 한다 — 이걸 놓치면 서버 상태 피처가 전부 0으로 굳는데 **에러 없이** 그렇게 된다.
17. **CDP 스로틀링은 Client Hints에 반영되지 않는다.** 워커가 CPU 4배·3G를 걸어도 서버에는 `ect: 4g`, 고사양 기기로 보인다. 이대로 두면 랩 데이터의 기기·네트워크 피처가 전부 상수가 되어 **모델이 배우려는 축 자체가 사라진다.** 워커가 실제 건 조건을 `x-cell-*` 헤더로 주입하고, 결정 계층이 이를 우선한다.
18. **첫 페이지뷰는 구조적으로 콜드 스타트다.** `hardwareConcurrency`에 대응하는 Client Hint는 표준에 없고, 이전 페이지뷰의 실측 LCP·TBT는 어떤 헤더로도 오지 않는다. 비콘이 세션 프로파일 쿠키에 적어준 뒤에야 정밀 피처를 쓸 수 있다. 이는 결함이 아니라 **실험에서 통제해야 할 조건**이다 — 첫 방문과 재방문을 같은 셀에 섞으면 안 된다.

---

## 12. 구현 순서

각 단계는 다음 단계의 전제를 검증한다. 순서를 건너뛰면 나중에 데이터를 버리게 된다.

| 단계 | 내용 | 검증 | 상태 |
|---|---|---|---|
| 1 | 골격 — 라우트 정의, 결정적 생성기, 콘텐츠형 1종 × 5모드 | 5개 모드의 최종 DOM이 동일한가 | 완료 |
| 2 | 계측 — 상관 ID, 비콘, CPU 시간, 캐시 상태 | 서버 레코드와 클라이언트 비콘이 100% 조인되는가 | 완료 |
| 3 | 유형 확대 — 5유형 × 5인스턴스 = 25 라우트 | **유형별 모드 우열이 서로 다른 방향인가** (§5) | 완료 |
| 4 | 결정 계층 — 프록시, 정책 플러그인, 후보 모드 배제, 마진 폴백 | 정책 교체가 앱 코드에 영향을 주지 않는가 / 추론 오버헤드 < 2ms인가 | 완료 |
| 5 | 부하·측정 워커 — k6 캘리브레이션, Playwright, 상호작용 시퀀스 | 반복 30회의 분산이 모드 간 차이보다 작은가 | 미착수 |

3단계에서 모든 유형이 같은 모드를 선호하면 §5의 파라미터를 재조정한다. 5단계 검증이 통과하지 못하면 **factorial 수집을 시작해선 안 된다.** 노이즈가 신호보다 크면 10,000셀을 모아도 결정 경계가 나오지 않는다.

### 4단계 결과

추론 오버헤드는 예산(2ms)의 1% 수준이다. 서러게이트가 p95 0.022ms로 가장 비싸고,
그마저 후보 4~5개를 전부 채점한 값이다 — 깊이 5 트리 평가는 실질적으로 공짜다.
**병목은 추론이 아니라 피처 수집이었을 것**이므로, 라우트 특징을 모듈 초기화 시 한 번만
룩업 테이블로 만든 것(§10)이 이 수치를 만든 이유다.

정책별 적용 모드(스로틀링 없는 상태, 콜드 스타트):

| 정책 | content | list | dashboard | form | personalized |
|---|---|---|---|---|---|
| fixed-ssg | ssg | ssg | stream (infeasible) | stream (infeasible) | stream (infeasible) |
| rule-based | csr | csr | csr | csr | csr |
| surrogate | ssg | ssg | islands | stream (margin) | ssr |

두 가지가 눈에 띈다.

- **`fixed-ssg`는 5개 라우트 중 3개에서 성립하지 않는다.** 이것이 기준선 비교에서
  반드시 보고되어야 하는 수치다. "고정 SSG가 좋았다"는 결론은 그 정책이 실제로는
  절반 이상의 라우트에서 Streaming SSR이었다는 사실 없이는 해석할 수 없다.
- **`rule-based`는 콜드 스타트에서 전부 CSR을 고른다.** Client Hints가 없으면 기기·네트워크가
  전부 기본값이라 "약한 기기/느린 망" 조건이 거짓이 되기 때문이다. 그런데 3단계 실측에서
  CSR은 모든 유형에서 명확한 열위였다. 즉 이 휴리스틱의 약점은 임계값이 아니라
  **첫 요청에 정보가 없다는 것**이고, 학습 모델이 이겨야 할 지점도 거기다.

단, 서러게이트는 **미학습 자리표시자**(`v0-unfitted`)다. 4단계가 검증한 것은 결정 계층의
배선과 비용이지 정책의 품질이 아니다.
