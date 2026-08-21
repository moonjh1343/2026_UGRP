# 벤치마크 앱 (SUT)

적응형 렌더링 연구의 측정 대상. 5개 렌더링 모드를 **단일 컴포넌트 정의**로 제공한다.

설계 근거는 [`../../docs/benchmark-app-design.md`](../../docs/benchmark-app-design.md), 연구 명세는 저장소 루트의 제안서에 있다.

## 실행

```bash
npm install
npm run build && npm start        # 프로덕션 빌드로만 측정한다 (dev 서버는 요청 시 컴파일)
```

인덱스: <http://127.0.0.1:3000/>

| 경로 | 모드를 정하는 주체 |
|---|---|
| `/<type>/<slug>` | **결정 계층** — 정책이 고르고 미들웨어가 재작성한다 |
| `/m/<mode>/<type>/<slug>` | **워커** — factorial 수집에서 정책을 우회한다 |

정책은 `x-policy` 헤더로 지정한다(`fixed-csr`·`fixed-ssr`·`fixed-stream`·`fixed-ssg`·
`fixed-islands`·`rule-based`·`surrogate`). 기본값은 `POLICY` 환경변수.

## 검증

서버가 떠 있는 상태에서 실행한다.

| 명령 | 확인하는 것 |
|---|---|
| `npm run check:dom` | **모드별 최종 DOM이 동일한가** — 1단계 합격 기준 |
| `npm run check:join` | **서버 레코드와 클라이언트 비콘이 조인되는가** — 2단계 합격 기준 |
| `npm run check:divergence` | **유형별 모드 우열이 서로 다른 방향인가** — 3단계 합격 기준 |
| `npm run check:policy` | **정책 교체가 앱에 영향 없는가 / 추론 < 2ms인가** — 4단계 합격 기준 |
| `npm run check:determinism` | 페이로드가 바이트 단위로 동일한가 + 인스턴스 포화 여부 |
| `npm run inspect:graph` | 모드별 클라이언트 그래프에 무엇이 들어 있는가 (Islands에 트리가 없어야 함) |
| `npm run report:bundles` | 모드별 HTML·JS 전송량 |
| `npm run analyze:routes` | 모드별 번들 KB 룩업 테이블 생성 (→ 재빌드 필요) |
| `npm run measure:render` | `C_render(m)` 산출 — 반복 집계 기반 |

`check:dom`이 통과해야 이후 측정된 모드 간 차이를 "렌더 방식의 차이"로 해석할 수 있다. 트리 정의가 갈라져 있으면 그 차이가 코드 차이인지 렌더 방식 차이인지 구분할 수 없다.

`check:join`이 통과해야 피처(서버 측)와 결과(클라이언트 측)를 이을 수 있다. 이 조인이 끊기면 데이터셋 전체가 쓸모없어진다.

`check:divergence`는 CDP로 CPU·네트워크를 스로틀링한다(`CPU=4 REPEATS=8 npm run check:divergence`). 스로틀링 없이는 모든 모드가 비슷하게 보여 검증이 무의미하다. 지표는 스크립트가 직접 읽지 않고 **앱의 비콘 파이프라인에서 조회**한다 — `getEntriesByType`으로는 LCP·롱태스크가 잡히지 않는다.

`check:policy`는 다섯 가지를 본다: 임포트 경계(A), 공개 URL과 직접 경로의 DOM 동등성(B),
추론 오버헤드(C), M(r) 준수와 폴백 기록(D), 세션 전환 상한(E). B가 "ssr → ssr"을 비교하며
통과하는 상태가 되기 쉬우므로, 봇 판정 검사를 함께 넣어 두었다(아래 주의 참조).

### 계측 엔드포인트

| 경로 | 용도 |
|---|---|
| `POST /api/beacon` | RUM 수집 (5단계에서 Kinesis로 교체) |
| `GET /api/internal/metrics` | 서버 상태 스냅샷 — 결정 계층이 30초 주기로 캐시해 쓴다 |
| `GET/DELETE /api/internal/records` | 조인 검증용 레코드 덤프 (임시) |
| `GET /api/internal/policy` | 정책 목록·τ·모델 버전 — 검증 스크립트가 하드코딩을 피한다 |
| `POST /api/internal/revalidate` | ISR 캐시 무효화 — 워커가 캐시 상태를 셀 변수로 통제한다 |

## 구조

```
app/m/<mode>/<type>/[slug]/page.tsx    세그먼트 설정 선언 + 자기 트리 주입 (각 5줄)
lib/render/<mode>.tsx                  모드별 렌더 — 트리를 **인자로 받는다**
lib/render/shell.tsx                   공용 — 라우트 해석과 M(r) 검증. 트리를 임포트하지 않는다
components/trees/<Type>Tree.tsx        지시어 없음 — 두 그래프 공용 (트리 정의는 이 한 벌뿐)
components/trees/<Type>Tree.client.tsx 'use client' 경계 심
components/shell/roots/<Type>Root.tsx  CSR 진입점 — 자기 트리만 임포트
components/leaves/                     지시어 없음 — 두 그래프 공용
components/widgets/                    'use client' — Islands의 섬
lib/chart/scale.ts                     대시보드형만 임포트 — 유형별 코드 무게의 원천
lib/data/<type>.ts                     결정적 생성기 (시드 고정)
lib/routes.ts                          25개 라우트 정의 + candidateModes (제안서 §3.1.1)
lib/instrument/                        상관 ID, 레코드, 서버 상태
middleware.ts                          결정 계층 실행 지점 — 라우팅보다 먼저 모드를 정한다
policy/                                결정 계층. 앱을 임포트하지 않는다 (아래)
```

### 결정 계층 (`policy/`)

```
index.ts       decide() — 가드 체인. 정책은 여기를 통과해야 적용된다
policies.ts    POLICIES 맵 — 정책 추가는 이 파일 한 줄이다
surrogate.ts   증류 트리 평가기 — argmin over M(x)
model/         증류 트리 JSON (현재 trained-20260818T163155Z, 깊이 12·687KB)
features.ts    헤더·쿠키 → Features, 트리 입력 벡터
routeTable.ts  라우트 정적 특징 룩업 (모듈 초기화 시 1회)
serverState.ts 서버 상태 30초 캐시 — 절대 await 하지 않는다
session.ts     세션·라우트별 결정 쿠키 (전환 상한)
config.ts      τ, TTL, 서킷 브레이커 — 전부 환경변수로 덮인다
```

가드 체인의 순서가 곧 우선순위다.

```
forced → single → bot → circuit → policy → infeasible → margin → session-cap
```

정책은 "무엇을 고르고 싶은가"만 말한다. 실행 가능성·안전장치·전환 상한은 전부
`decide()`가 강제하므로, 정책을 추가할 때 안전장치를 다시 구현할 필요가 없다.
`fixed-ssg`가 개인화 라우트에서 `stream`으로 떨어지는 것이 이 구조의 결과이고,
그 폴백은 `x-decision-reason: infeasible`로 **기록된다** — 정책이 스스로 후보 안으로
접어버리면 "몇 번 성립하지 못했는가"를 셀 수 없어 기준선 비교를 해석할 수 없다.

라우트는 유형 5종 × 인스턴스 5개. 유형별 **지배 축 하나만** ±60%로 흩뿌린다 — 모든 축을 동시에 흔들면 어떤 축이 결정을 갈랐는지 사후에 분리할 수 없다.

| 유형 | 지배 축 | SSG |
|---|---|---|
| content | `payloadKB` (전송 바이트) | 가능 |
| list | `nodeCount` (DOM 노드) | 가능 (θ_p=0.2 아래) |
| dashboard | `interactiveCount` (하이드레이션 CPU) | 배제 |
| form | `interactiveCount` (INP) | 배제 |
| personalized | `fetchDelayMs` (서버 부하 민감) | 배제 |

`Σ|M(r)| = 110` — 행동 공간의 크기다. 실제 측정 셀은 SSG의 캐시 상태 축(miss/hit/stale)이
붙어 `80 × (110 + 10×2) = 10,400`이 된다(제안서 §5.2).

### 손대기 전에 알아야 할 것

- **`lib/render/shell.tsx`에서 트리를 임포트하면 안 된다.** 공용 모듈이 `ContentTree.client`를 참조하는 순간 Islands 라우트의 번들에도 트리가 끌려 들어가 모드 구분이 사라진다. 임포트 그래프는 `switch` 분기를 따라가지 않는다.
- **`Math.random()`·`Date.now()` 금지.** 셀당 30회 반복의 분산이 곧 측정 노이즈다. `lib/rng.ts`의 시드 PRNG를 쓴다.
- **위젯의 초기 렌더가 서버·클라이언트에서 동일해야 한다.** `useState` 초기값이 브라우저 API에 의존하면 하이드레이션 불일치가 나고 DOM 동등성 검증이 깨진다.
- **의도적으로 남긴 비효율이 있다.** CSR의 추가 왕복(셸 → JS → API fetch), SSR의 데이터 이중 전송은 최적화 대상이 아니라 측정 대상이다.
- **`app/layout.tsx`에서 `headers()`·`cookies()`를 쓰면 안 된다.** 하나라도 쓰면 SSG 경로가 강제로 동적 렌더가 되어 모드 구분이 무너진다. 상관 ID를 HTML이 아니라 `Server-Timing` 헤더로 나르는 이유이기도 하다.
- **밑줄로 시작하는 폴더는 라우팅에서 제외된다.** `app/m/`, `app/api/internal/`에 밑줄이 없는 이유다. 빌드는 성공하지만 라우트가 등록되지 않는다.
- **per-request CPU는 지표가 아니다.** 플랫폼 타이머 양자화(Windows 15.625ms)로 0이 나온다. `C_render`는 `measure:render`의 반복 집계로 구한다.
- **생성기의 `clamp` 상한을 확산 최대 배율보다 넉넉히 둘 것.** 상한에 걸리면 상단 인스턴스들이 같은 페이로드로 붕괴해 그리드 커버리지를 조용히 잃는다. `check:determinism`이 이를 잡는다.
- **헤드리스 브라우저를 봇으로 분류하면 안 된다.** 측정 워커가 곧 헤드리스 Chrome이다. 봇 패턴에 `headlesschrome`을 넣으면 모든 워커 요청이 SSR로 하드핀되고, 검증은 "ssr vs ssr"을 비교하면서 **통과한다.** 4단계 첫 실행에서 실제로 그렇게 통과했다.
- **`policy/`는 `app/`·`components/`·`node:*`를 임포트하면 안 된다.** 앞의 둘은 정책 교체 시 앱이 함께 흔들리기 때문이고, 마지막은 이 코드가 Lambda@Edge로 떨어져 나갈 것이기 때문이다. `check:policy`의 A절이 검사한다.
- **서버 상태 갱신은 `event.waitUntil`에 넘길 것.** 부유 Promise로 두면 응답 반환 후 취소되어 캐시가 영영 비고, 서버 상태 피처가 전부 0으로 굳는다. **에러 없이** 그렇게 된다.
- **CDP 스로틀링은 Client Hints를 바꾸지 않는다.** 워커가 실제 건 조건을 `x-cell-device-tier`·`x-cell-effective-type` 헤더로 주입해야 한다. 안 하면 랩 데이터의 기기·네트워크 피처가 전부 상수가 되어 모델이 배우려는 축이 사라진다.

## 진행 현황

| 단계 | 상태 |
|---|---|
| 1 — 골격 (콘텐츠형 × 5모드) | 완료 (`check:dom` 통과) |
| 2 — 계측 (상관 ID·비콘·CPU·서버 상태) | 완료 (`check:join` 통과) |
| 3 — 유형 확대 (5유형 × 5인스턴스 = 25 라우트) | 완료 (`check:divergence` 통과) |
| 4 — 결정 계층 (정책 플러그인) | 완료 (`check:policy` 통과) |
| 5 — 부하·측정 워커 | 완료 — [`../../workers/`](../../workers/), [`../../load/`](../../load/) |

### 3단계 결과 (CPU 4× · 3G Fast · n=8 중앙값)

| 유형 | 최우수 | 2위와의 점수 차 | 해석 |
|---|---|---|---|
| content | ssg | 큼 (1016 → 2852) | 캐시 가능 + SEO — 예상대로 |
| list | ssg | 작음 (1150 → 1226) | islands·ssr과 노이즈 수준 |
| dashboard | islands | 없음 (864 → 867) | ssr과 사실상 동률 |
| form | stream | 없음 (709 → 724) | ssr·islands와 동률 |
| personalized | ssr | 없음 (734 → 737) | islands와 동률 |

**확실한 것은 두 가지뿐이다.** CSR이 모든 유형에서 명확히 열위이고(3G에서 추가 왕복이 지배적), SSG가 가능한 유형에서 큰 폭으로 우세하다. 나머지 유형은 상위 3개 모드가 측정 노이즈 안에 있다.

이는 제안서 §3.5의 **마진 기반 폴백이 실질적으로 중요하다**는 근거다 — 상위 두 모드의 예측 차가 τ 미만이면 전환하지 않는 것이 옳다. 전환에는 캐시 파편화라는 고정 비용이 있기 때문이다.

**반복 수 주의.** n=3에서는 순위가 실행마다 뒤집힌다(`content`가 ssr↔stream↔ssg). n=8에서 안정된 것처럼 보였다.

> **n=8도 부족했다.** 5단계에서 같은 셀을 n=30으로 다시 재니 `content`의 값이 위 표와
> 크게 달랐다(ssr 2852 → 774). `dashboard`·`form`은 거의 일치했으므로 하네스 차이가 아니라
> **n=8 중앙값의 오염**이다. 위 `content` 행은 신뢰하지 말고 아래 5단계 결과를 보라.
> 제안서 §5.2가 셀당 30회를 규정하는 이유가 이것이다.

### 4단계 결과 (스로틀링 없음 · 콜드 스타트)

추론 오버헤드는 예산(2ms)의 **1% 수준**이다. 서러게이트가 p95 0.022ms로 가장 비싸고,
그마저 후보 4~5개를 전부 채점한 값이다. 병목이 될 뻔한 것은 추론이 아니라 피처 수집이었고,
라우트 특징을 모듈 초기화 시 한 번만 룩업 테이블로 만든 것이 이 수치의 이유다.

| 정책 | content | list | dashboard | form | personalized |
|---|---|---|---|---|---|
| fixed-ssg | ssg | ssg | stream *(infeasible)* | stream *(infeasible)* | stream *(infeasible)* |
| rule-based | csr | csr | csr | csr | csr |
| surrogate | ssg | ssg | islands | stream *(margin)* | ssr |

- `fixed-ssg`는 5개 라우트 중 **3개에서 성립하지 않는다.** 기준선 비교에서 반드시 함께
  보고되어야 하는 수치다 — "고정 SSG가 좋았다"는 결론은 그 정책이 실제로는 절반 이상의
  라우트에서 Streaming SSR이었다는 사실 없이는 해석할 수 없다.
- `rule-based`는 콜드 스타트에서 **전부 CSR을 고른다.** Client Hints가 없어 "약한 기기/느린 망"
  조건이 거짓이 되기 때문인데, 3단계 실측에서 CSR은 모든 유형에서 명확한 열위였다.
  이 휴리스틱의 약점은 임계값이 아니라 **첫 요청에 정보가 없다는 것**이다.
- `form`이 마진 폴백에 걸렸다 — `islands`(0.72)와 `ssr`(0.75)의 차가 τ=0.05 미만이라
  전환하지 않고 `stream`으로 떨어졌다. 3단계에서 이 유형의 상위 3개 모드가 노이즈 안에
  있었던 것과 일치한다.

**당시 서러게이트는 미학습 자리표시자(`v0-unfitted`)였다.** 4단계가 검증한 것은 결정
계층의 배선과 비용이지 정책의 품질이 아니었다. 지금 `policy/model/tree.v0.json`은 6단계
본수집 `grid-v1`으로 학습·증류한 트리(`trained-20260818T163155Z`, λ=0.3·깊이 12)이고,
라우트 홀드아웃 400조건에서 top-1 74.2%·regret 0.046이다. 위 표의 결정들은 그 교체 이전
값이므로 정책 품질의 근거로 읽지 말 것 — 읽어야 할 것은 가드 체인이 도는 방식이다.

### 5단계 결과 (CPU 4× · 3G Fast · Idle · n=30)

| 유형 | 최우수 | pooled_sd | 분산비 | 분해능 | 이상치 |
|---|---|---|---|---|---|
| content | ssg 736 | 25.3 | 0.016 | 1.81 | 24% |
| dashboard | ssr 838 | 27.2 | 0.021 | 4.54 | 3% |
| form | ssr 685 | 21.7 | 0.020 | 21.70 | 1% |

**반복 노이즈는 문제가 아니다** — pooled_sd가 21~27점인데 CSR과의 격차는 1000점을 넘는다.
동시에 세 유형 전부에서 1·2위가 노이즈 안에 있다(form은 상위 3개가 3점 안에 모여 있다).
3단계에서 본 것과 같은 사실이고, **마진 폴백 τ가 필요한 이유의 실측 근거**다.

3단계 n=8 결과와 비교하면 dashboard·form은 거의 일치하지만 **content는 어긋난다**
(3단계 ssr 2852 → 5단계 774). n=8의 중앙값이 오염됐던 것이고, 이것이 제안서 §5.2가
셀당 30회를 규정하는 이유다.

`content`의 이상치 제거율 24%는 남은 문제다. 분포가 단봉이 아닐 가능성이 높고,
MAD 트리밍은 그것을 고치는 게 아니라 가린다 — 실제 수집 전에 원인을 규명해야 한다.
