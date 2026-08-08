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
| `npm run check:dom` | **5개 모드의 최종 DOM이 동일한가** — 1단계 합격 기준 |
| `npm run check:determinism` | 같은 라우트를 반복 요청해도 페이로드가 바이트 단위로 동일한가 |
| `npm run inspect:graph` | 모드별 클라이언트 그래프에 무엇이 들어 있는가 (Islands에 트리가 없어야 함) |
| `npm run report:bundles` | 모드별 HTML·JS 전송량 |

`check:dom`이 통과해야 이후 측정된 모드 간 차이를 "렌더 방식의 차이"로 해석할 수 있다. 트리 정의가 갈라져 있으면 그 차이가 코드 차이인지 렌더 방식 차이인지 구분할 수 없다.

## 구조

```
app/m/<mode>/content/[slug]/page.tsx   세그먼트 설정만 선언, 렌더는 위임 (각 5줄)
lib/render/<mode>.tsx                  모드별 렌더 — 각자 필요한 것만 임포트
lib/render/shell.tsx                   공용 — 라우트 해석과 M(r) 검증. 트리를 임포트하지 않는다
components/trees/ContentTree.tsx       지시어 없음 — 두 그래프 공용 (트리 정의는 이 한 벌뿐)
components/trees/ContentTree.client.tsx  'use client' 경계 심
components/leaves/                     지시어 없음 — 두 그래프 공용
components/widgets/                    'use client' — Islands의 섬
lib/data/                              결정적 생성기 (시드 고정)
lib/routes.ts                          라우트 정의 + candidateModes (제안서 §3.1.1)
```

### 손대기 전에 알아야 할 것

- **`lib/render/shell.tsx`에서 트리를 임포트하면 안 된다.** 공용 모듈이 `ContentTree.client`를 참조하는 순간 Islands 라우트의 번들에도 트리가 끌려 들어가 모드 구분이 사라진다. 임포트 그래프는 `switch` 분기를 따라가지 않는다.
- **`Math.random()`·`Date.now()` 금지.** 셀당 30회 반복의 분산이 곧 측정 노이즈다. `lib/rng.ts`의 시드 PRNG를 쓴다.
- **위젯의 초기 렌더가 서버·클라이언트에서 동일해야 한다.** `useState` 초기값이 브라우저 API에 의존하면 하이드레이션 불일치가 나고 DOM 동등성 검증이 깨진다.
- **의도적으로 남긴 비효율이 있다.** CSR의 추가 왕복(셸 → JS → API fetch), SSR의 데이터 이중 전송은 최적화 대상이 아니라 측정 대상이다.

## 1단계 현황

콘텐츠형 5개 인스턴스 × 5개 모드. 라우트 유형 확대(목록·대시보드·폼·개인화)는 3단계다.

미해결 사항은 설계 문서 §5의 "비용 노브는 데이터 무게만 바꾼다"를 참고하라 — 현재 노브가 컴포넌트 코드 크기를 바꾸지 않아 번들 크기에 라우트 간 분산이 없다.
