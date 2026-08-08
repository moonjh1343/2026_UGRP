# 벤치마크 앱 (SUT)

적응형 렌더링 연구의 측정 대상. 5개 렌더링 모드를 **단일 컴포넌트 정의**로 제공한다.

설계 근거는 [`../../docs/benchmark-app-design.md`](../../docs/benchmark-app-design.md), 연구 명세는 저장소 루트의 제안서에 있다.

## 실행

```bash
npm install
npm run build && npm start        # 프로덕션 빌드로만 측정한다 (dev 서버는 요청 시 컴파일)
```

인덱스: <http://127.0.0.1:3000/>
모드별 경로: `/m/<csr|ssr|stream|ssg|islands>/content/<slug>`

## 검증

서버가 떠 있는 상태에서 실행한다.

| 명령 | 확인하는 것 |
|---|---|
| `npm run check:dom` | **모드별 최종 DOM이 동일한가** — 1단계 합격 기준 |
| `npm run check:join` | **서버 레코드와 클라이언트 비콘이 조인되는가** — 2단계 합격 기준 |
| `npm run check:divergence` | **유형별 모드 우열이 서로 다른 방향인가** — 3단계 합격 기준 |
| `npm run check:determinism` | 페이로드가 바이트 단위로 동일한가 + 인스턴스 포화 여부 |
| `npm run inspect:graph` | 모드별 클라이언트 그래프에 무엇이 들어 있는가 (Islands에 트리가 없어야 함) |
| `npm run report:bundles` | 모드별 HTML·JS 전송량 |
| `npm run measure:render` | `C_render(m)` 산출 — 반복 집계 기반 |

`check:dom`이 통과해야 이후 측정된 모드 간 차이를 "렌더 방식의 차이"로 해석할 수 있다. 트리 정의가 갈라져 있으면 그 차이가 코드 차이인지 렌더 방식 차이인지 구분할 수 없다.

`check:join`이 통과해야 피처(서버 측)와 결과(클라이언트 측)를 이을 수 있다. 이 조인이 끊기면 데이터셋 전체가 쓸모없어진다.

`check:divergence`는 CDP로 CPU·네트워크를 스로틀링한다(`CPU=4 REPEATS=8 npm run check:divergence`). 스로틀링 없이는 모든 모드가 비슷하게 보여 검증이 무의미하다. 지표는 스크립트가 직접 읽지 않고 **앱의 비콘 파이프라인에서 조회**한다 — `getEntriesByType`으로는 LCP·롱태스크가 잡히지 않는다.

### 계측 엔드포인트

| 경로 | 용도 |
|---|---|
| `POST /api/beacon` | RUM 수집 (5단계에서 Kinesis로 교체) |
| `GET /api/internal/metrics` | 서버 상태 스냅샷 — 결정 계층이 30초 주기로 캐시해 쓴다 |
| `GET/DELETE /api/internal/records` | 조인 검증용 레코드 덤프 (임시) |

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
```

라우트는 유형 5종 × 인스턴스 5개. 유형별 **지배 축 하나만** ±60%로 흩뿌린다 — 모든 축을 동시에 흔들면 어떤 축이 결정을 갈랐는지 사후에 분리할 수 없다.

| 유형 | 지배 축 | SSG |
|---|---|---|
| content | `payloadKB` (전송 바이트) | 가능 |
| list | `nodeCount` (DOM 노드) | 가능 (θ_p=0.2 아래) |
| dashboard | `interactiveCount` (하이드레이션 CPU) | 배제 |
| form | `interactiveCount` (INP) | 배제 |
| personalized | `fetchDelayMs` (서버 부하 민감) | 배제 |

`Σ|M(r)| = 110` — 제안서 §5.2의 8,800셀 그리드(`80 × 110`)와 일치한다.

### 손대기 전에 알아야 할 것

- **`lib/render/shell.tsx`에서 트리를 임포트하면 안 된다.** 공용 모듈이 `ContentTree.client`를 참조하는 순간 Islands 라우트의 번들에도 트리가 끌려 들어가 모드 구분이 사라진다. 임포트 그래프는 `switch` 분기를 따라가지 않는다.
- **`Math.random()`·`Date.now()` 금지.** 셀당 30회 반복의 분산이 곧 측정 노이즈다. `lib/rng.ts`의 시드 PRNG를 쓴다.
- **위젯의 초기 렌더가 서버·클라이언트에서 동일해야 한다.** `useState` 초기값이 브라우저 API에 의존하면 하이드레이션 불일치가 나고 DOM 동등성 검증이 깨진다.
- **의도적으로 남긴 비효율이 있다.** CSR의 추가 왕복(셸 → JS → API fetch), SSR의 데이터 이중 전송은 최적화 대상이 아니라 측정 대상이다.
- **`app/layout.tsx`에서 `headers()`·`cookies()`를 쓰면 안 된다.** 하나라도 쓰면 SSG 경로가 강제로 동적 렌더가 되어 모드 구분이 무너진다. 상관 ID를 HTML이 아니라 `Server-Timing` 헤더로 나르는 이유이기도 하다.
- **밑줄로 시작하는 폴더는 라우팅에서 제외된다.** `app/m/`, `app/api/internal/`에 밑줄이 없는 이유다. 빌드는 성공하지만 라우트가 등록되지 않는다.
- **per-request CPU는 지표가 아니다.** 플랫폼 타이머 양자화(Windows 15.625ms)로 0이 나온다. `C_render`는 `measure:render`의 반복 집계로 구한다.
- **생성기의 `clamp` 상한을 확산 최대 배율보다 넉넉히 둘 것.** 상한에 걸리면 상단 인스턴스들이 같은 페이로드로 붕괴해 그리드 커버리지를 조용히 잃는다. `check:determinism`이 이를 잡는다.

## 진행 현황

| 단계 | 상태 |
|---|---|
| 1 — 골격 (콘텐츠형 × 5모드) | 완료 (`check:dom` 통과) |
| 2 — 계측 (상관 ID·비콘·CPU·서버 상태) | 완료 (`check:join` 통과) |
| 3 — 유형 확대 (5유형 × 5인스턴스 = 25 라우트) | 완료 (`check:divergence` 통과) |
| 4 — 결정 계층 (정책 플러그인) | 미착수 |
| 5 — 부하·측정 워커 | 미착수 |

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

**반복 수 주의.** n=3에서는 순위가 실행마다 뒤집힌다(`content`가 ssr↔stream↔ssg). n=8에서 안정됐다. 4단계 정책 학습에는 제안서 §5.2가 규정하는 30회를 써야 한다.
