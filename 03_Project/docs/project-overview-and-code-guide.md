# 프로젝트 개요와 코드 구조 가이드

처음 이 저장소를 보는 사람이 "무엇을 하는 연구인지"와 "코드가 어떻게 그 연구를 구현하는지"를
한 번에 파악할 수 있도록 정리한 문서다. 권위 문서는 `adaptive-rendering-research-proposal.md`,
SUT 상세는 `benchmark-app-design.md`이며, 이 문서는 그 둘로 들어가기 전의 지도 역할을 한다.

---

## 1부. 무엇을 하는 연구인가

### 상황 적응적 렌더링 모드 선택

Next.js 같은 프레임워크는 CSR/SSR/SSG(ISR)/Streaming SSR/Islands 중 하나를 라우트마다
**빌드 시점에** 고정한다. 이 연구는 그 선택을 **런타임 함수**로 본다 — 클라이언트 기기 성능,
네트워크 품질, 서버의 순간 부하에 따라 최적 모드가 달라지므로, 요청마다 모드를 고르는 정책을
**학습**한다.

수식으로는, 문맥 `x`(기기·네트워크·서버 상태)와 라우트 `r`이 주어지면:

```
mode*(x, r) = argmin over m ∈ M(r) of Ĵ(x, m)
Ĵ = Σ wᵢ·z_r(QoEᵢ) + λ·ServerCost
```

이미 논증이 끝난 설계 결정들 (재론하려면 명시적으로):

- **분류가 아니라 회귀 + argmin.** "두 모드가 거의 비슷하다"는 마진 정보가 필요하다 —
  모드 전환에는 캐시 파편화라는 고정 비용이 있어 근소한 차이면 안 바꾸는 게 맞다.
- **λ는 하이퍼파라미터가 아니라 그림자 가격.** QoE 대 서버 비용은 제약 최적화
  (E[ServerCost] ≤ B)로 재정식화되고 λ는 dual ascent로 온라인 조정된다.
- **라벨은 라우트별 z-score 정규화.** 건너뛰면 "무거운 페이지 = 나쁨"만 학습하고
  모드 간 신호(진짜 목표)가 죽는다.
- **ML은 SEO·정확성을 결정하지 않는다.** 크롤러 UA와 결제/인증 라우트는 SSR 하드핀,
  이상 징후 시 서킷 브레이커가 전 트래픽을 기본 모드(Streaming SSR)로 되돌린다.

### 핵심 문제: 반사실(counterfactual)

실서비스 데이터로는 한 요청에 한 모드만 관측된다. "같은 조건에서 다른 모드였다면?"을 알 수
없다. 그래서 **실험실 full-factorial 수집**으로 우회한다 — 재현 가능한 조건이라면 같은 조건에서
모든 모드를 다 재볼 수 있다.

그리드:

| 축 | 값 |
|---|---|
| 기기 | 4단계 (CPU 스로틀 1×/2×/4×/6×) |
| 네트워크 | 5단계 (5g/lte/3g-fast/3g-slow/offline-first) |
| 서버 부하 | 4단계 (idle/low/mid/high) |
| 모드 | 라우트별 실행 가능 모드 Σ\|M(r)\| = 110 + SSG 캐시 상태 축 20 |

= 80 조건 × 130 = **10,400셀**, 셀당 30회 반복. 직렬 813시간 → 20샤드 병렬로 40.7시간.

샤드 하나는 **(SUT + 부하 생성기 + 측정 워커) 삼중쌍**이고 샤드끼리 아무것도 공유하지 않는다 —
두 워커가 한 SUT를 치면 서로의 부하 수준을 깬다. 배경 부하는 **외생 변수여야** 하므로(렌더
모드 자체가 서버 부하를 바꾸는데 부하가 특징이기도 하다) 생성기가 목표 CPU에 맞춘 VU 수로
부하를 고정하고, 측정 요청 하나가 그 위에 올라탄다.

### 현재 상태 (2026-08-16 기준)

1~5단계와 7단계 **코드는 전부 완성**되어 각자의 검증 게이트를 통과했고, 6단계 본수집이
거의 끝났다:

- **6단계 본수집 `grid-v1`** — 20 Fargate 샤드, 10,400셀 × 30 reps. 2026-08-14 01:26 시작,
  8/16 기준 97%(high 부하 샤드 2개가 꼬리, 8/18 새벽 완료 예상). 데이터는 S3
  `ugrp-grid-v1-data-results25575328-fm3me6shxv6z/experiment=grid-v1/`, 체크포인트는
  DynamoDB. 이전 파일럿(`workers/runs/pilot-low-idle/`, slice-b2)은 SSG 캐시 축이
  revalidate no-op 버그로 의심 대상이라 학습에 쓰지 않는다.
- 부하 축은 제안서의 30/65/90이 아니라 **30/50/70% CPU**다 — 2 vCPU SUT의 천장이 ~71%라
  90%는 도달 불가(`load/README.md`). high 셀은 실측 63.8–68.9%가 기록된다.
- 정책이 서빙하는 트리는 아직 `v0-unfitted` 플레이스홀더. `training/out/`의 평가 리포트는
  n=2 조건짜리 스모크 테스트 산출물이다 — 결과로 읽지 말 것.
- 비용: 제안서 추정 $282–343 → 실측 약 **$440**(실패한 시도 5회의 유휴 과금 + high 샤드
  꼬리 1.5일). 예산 ₩300,000 + 크레딧 $160을 ~$60 넘겼다.

### 다음 단계 (수집 종료 후)

1. 잔여 서비스 0 → `Orchestration`·`Shards` 스택 삭제(`infra/README.md` "수집이 끝나면").
2. `aws s3 sync`로 `workers/runs/grid-v1/`에 받고 데이터 검증 — 부하 수준별 n 분포(high는
   n<30 흔함), 샤드별 실측 `cpuPct`, 캐시 축(miss/hit/stale) 전이가 기대대로인지.
3. `training/`에서 `--runs grid-v1 --distill` → `npm run check:tree` → `policy/model/`
   교체 → 서빙 평면 배포(`edge/README.md`).
4. 논문 5장 수치 채우기(`docs/paper-outline.md`).

---

## 2부. 코드 구조와 기능

여섯 패키지가 "실험 설계 → 측정 → 학습 → 서빙"의 인과 순서로 이어진다.
추천 읽기 순서: `lib/routes.ts` → `lib/render/` → `policy/policies.ts` → `workers/run.mjs`
→ `workers/lib/shard.mjs` → `training/scripts/train.py` → `edge/origin-request.mjs`.

### 2.1 `apps/benchmark/` — SUT (측정 대상 앱)

한 코드베이스에서 5개 모드를 전부 구현한 Next.js App Router 앱. 네 개 층으로 나뉜다.

**`lib/routes.ts` — 라우트 정의.** 5개 유형 × 규모 5단계(`SPREAD = [0.4, 0.7, 1.0, 1.3, 1.6]`)
= 30개 라우트를 코드로 생성한다. 핵심은 `DOMINANT_AXIS` — 유형마다 **숫자 축 하나만** 스케일한다
(content→`payloadKB`, list→`nodeCount`, dashboard/form→`interactiveCount`,
personalized→`fetchDelayMs`). 모든 축을 동시에 흔들면 어떤 축이 결정을 갈랐는지 사후 분리가
불가능하기 때문이다. `NumericAxis` 매핑 타입이 문자열 필드를 축으로 지정하는 실수를 컴파일
타임에 막는다.

**`app/m/<mode>/<type>/[slug]/` — 라우팅.** URL 구조 자체가 실험 설계다:
`/m/csr/content/content-md`처럼 모드가 경로에 박혀 있어 같은 페이지를 5개 모드로 요청할 수
있다. `ssg/` 아래에 content와 list만 있는 것은 `M(r)`이 라우트마다 다름(dashboard/form/
personalized는 SSG 불가)이 디렉터리 구조로 강제된 것이다.

**`components/` — 공유 컴포넌트 그래프.** 모드 간 비교가 성립하려면 다섯 모드가 같은 DOM을
만들어야 한다(`check:dom`이 게이트).

| 디렉터리 | 역할 |
|---|---|
| `trees/` | 유형별 페이지 트리. `*.tsx`(서버)·`*.client.tsx`(클라이언트) 쌍이 같은 leaves를 조립 |
| `leaves/` | 순수 표시 컴포넌트 (KpiTile, ListRow, …). 모드 무관 |
| `widgets/` | 인터랙티브 컴포넌트 (SortableTable, FormField, …). Islands에서 이것들만 hydrate |
| `shell/` | CSR 클라이언트 진입점 팩토리(`makeClientRoot.tsx`) + 유형별 roots |
| `instrument/` | `Beacon.tsx`(web-vitals → `/api/beacon`), `HydrationWatch.tsx`(hydration 오류 감지) |

**`lib/render/` — 모드별 렌더 전략.** `csr.tsx`(빈 셸 + 클라이언트 루트),
`hydrated.tsx`(SSR + hydration), `stream.tsx`(Suspense 스트리밍), `islands.tsx`(위젯만
hydrate), `shell.tsx`(공통 골격). 페이지 파일은 얇고 모드 차이는 전부 여기에 있다.

**`lib/instrument/` — 조인의 서버 절반.** `correlation.ts`가 상관 ID를 발급·전파한다 —
서버 렌더 기록과 브라우저 비콘을 잇는 **무결성 핵심 경로**다(`check:join`이 게이트).
`record.ts`/`store.ts`는 렌더마다 모드·결정 이유·CPU 시간을 기록, `serverState.ts`는
부하 특징의 서버 측 집계.

**`policy/` — 결정 계층 (엣지행 코드).** `app/`·`components/`·`node:*` 임포트 금지 격리
구역이다 — 이 디렉터리가 그대로 Lambda@Edge 번들이 되고, `check:policy`가 경계를 강제한다.

- `features.ts` — 요청 헤더 → 24차원 특징 벡터. `FEATURE_ORDER`가 training의 `config.py`와
  **수동 동기화**되는 지점.
- `surrogate.ts` — depth-5 트리 평가기. `x[cur.feature] ?? 0`이라 특징 이름이 어긋나도
  에러 없이 0으로 읽는다 — 대표적인 조용한 실패 지점.
- `policies.ts` — `decide()`: 하드핀 → 실행 가능성 검사(불가 모드면
  `x-decision-reason: infeasible` 기록) → 트리 argmin → 마진 τ 검사.
- `model/tree.v0.json` — 서빙 중인 트리 (현재 `v0-unfitted`).

**`scripts/` — 검증 게이트.** 각 스크립트가 구현 단계 하나를 지킨다: `check-dom-equivalence`
(5모드 DOM 동일), `check-join`(서버↔비콘 조인), `check-type-divergence`(유형별 모드 우열이
서로 다른 방향), `check-policy`(정책 교체 무영향 + 추론 < 2ms), `check-distilled-tree`(트리
특징명이 `toVector()`에 존재), `check-determinism`(페이로드 바이트 동일).

### 2.2 `workers/` — 측정 워커 (자체 package.json)

- **`run.mjs`** — 수집 본체이자 **로컬·클라우드 겸용 단일 바이너리**. 환경변수 3개가 세계를
  가른다: `LOAD_CONTROL_URL`(부하를 in-process → 원격 재탐색으로),
  `UGRP_RESULTS_BUCKET`+`UGRP_CHECKPOINT_TABLE`(JSONL → S3+DynamoDB, 둘 중 하나만 주면
  거부 — 결과와 완료 마커가 다른 곳에 있으면 재개가 재개가 아니다). 흐름은 부하 그룹 루프:
  캘리브레이션 → 부하 투입 → 셀 순회 측정 → 체크포인트.
- **`lib/grid.mjs`** — 조건 그리드 정의: `DEVICES`(cpuThrottle 1/2/4/6),
  `NETWORKS`(latency 10~900ms), `LOADS`, `CACHE_STATES`(miss/hit/stale), `expandGrid()`.
  스크립트 인자가 아니라 **버전 관리되는 실험 정의**다.
- **`lib/shard.mjs`** — 정적 샤드 분할. `repCostSeconds`(stale 62s / 그 외 5s) 기반으로
  `allocateShardsByLoad`(부하 수준당 샤드 배분, 최대잉여법) → `planShards`(부하별 인덱스
  연속 배정). 어느 샤드가 어느 셀을 쟀는지가 실험 정의라서 CDK가 아니라 여기에 있다.
- **`lib/measure.mjs`** — Playwright + CDP 한 회 측정: `Emulation.setCPUThrottlingRate`,
  `Network.emulateNetworkConditions`, 그리고 **`x-cell-device-tier`/`x-cell-effective-type`
  헤더 주입** (CDP는 Client Hints를 안 바꾸므로 이게 없으면 기기·네트워크 특징이 데이터셋
  전체에서 상수가 된다).
- `lib/checkpoint.mjs` / `lib/cloudCheckpoint.mjs` — 로컬 done.jsonl ↔ DynamoDB 조건부
  쓰기, 같은 인터페이스.
- `lib/loadControl.mjs` — 원격 부하 제어 클라이언트. `calibrateRemote`는 버스트로 탐색하되
  **지속(sustained) 값**을 기록한다 — 짧은 버스트로 캘리브레이션하면 지속 CPU가 12~16%p
  낮게 앉는 함정 때문.
- `verify-variance.mjs`(5단계 합격 기준, n=30), `quarantine.mjs`(오염 창 표시 — 행 삭제
  대신), `diagnose-tail.mjs`(이상치 원인 진단).

### 2.3 `load/` — 배경 부하 (의존성 없음)

- `generator.mjs` — k6의 로컬 대역. VU 루프(생각시간 + 요청)로 SUT에 부하를 건다.
- `control.mjs` — HTTP 제어 API(`/vus`). Fargate에서 도는 것이 이것이고 워커가 원격 조종한다.
- `search.mjs` / `calibrate.mjs` — 목표 CPU(30/50/70%) → VU 수 지수 탐침·이진 탐색·지속 확인.
  `maxVus` 512 — 그 위는 SUT가 관측 불가가 된다(`load/README.md`).
- `profile.json` — 요청 믹스. **k6 배포 스크립트와 로컬 생성기가 같은 파일을 읽는 것**이
  캘리브레이션 값의 이식성을 만든다.

### 2.4 `infra/` — CDK 앱 (6개 스택)

- `bin/ugrp.ts` — 컨텍스트(`ugrp:digests`, `ugrp:shardCount`, `ugrp:filters`, …) 파싱 후
  스택 조립.
- `lib/config.ts` — **실험 조건으로서의 설정**: `REGION`(ap-northeast-2 고정),
  `MAX_AZS = 1`(AZ 간 RTT 편차 제거), `TASK_SIZE`(전부 2 vCPU/4GiB),
  `requireDigests`(sha256 아니면 합성 거부), `requireShardCount`(부하 수준 4개 미만 샤드
  거부), `parseFilters`(`loads` 키 거부 — 부하 축은 샤드 배정 소관).
- `lib/network-stack.ts` — NAT 없는 격리 VPC. 서브넷 3개(sut/measure/load 분리),
  게이트웨이 엔드포인트(S3·DynamoDB) + 인터페이스 엔드포인트 3개. 부하→워커 방향은 열지
  않는다.
- `lib/data-stack.ts` — S3(RETAIN·버전닝), DynamoDB 체크포인트(온디맨드·PITR),
  ECR 3개(IMMUTABLE).
- `lib/shard-stack.ts` — 샤드 n개 × (SUT 서비스 + 부하 서비스 + 워커 태스크 정의).
  리소스 9+7n개.
- `lib/orchestration-stack.ts` — Step Functions `Parallel`로 워커 RunTask(RUN_JOB,
  72h 타임아웃). 재시도는 인프라성 오류 2종에만 — `States.TaskFailed`를 넣으면 워커의
  **의도된** 자진 정지까지 재시도한다(slice-b2에서 실제로 4샤드 × 40분 낭비).
- `lib/serving-origin-stack.ts` / `lib/serving-stack.ts` — 서빙 평면(공개 ALB+SUT →
  CloudFront+Lambda@Edge, us-east-1). 실험용 VPC와 분리 — 랩 VPC에 인터넷 경로를 만들면
  "측정에 외부 요인 없음" 주장이 무너진다.

### 2.5 `edge/` — 서빙 평면

- `viewer-request.js` — CloudFront Function. 클라이언트 힌트를 `x-ugrp-bucket` 하나로
  접는다. **이 헤더만 캐시 키다** — 캐시 키가 이 설계의 전부.
- `origin-request.mjs` — Lambda@Edge. `policy/`의 `decide()`로 오리진 경로를 모드 경로로
  재작성. origin-request에서 도는 이유: 캐시 히트는 결정할 게 없으므로 비용 0.
- `config.generated.js` — 빌드 시 트리를 구워 넣은 산출물. AppConfig 대신 번들에 박는다
  (콜드 스타트 fetch가 요청 경로에 앉는 것을 피함).

### 2.6 `training/` — 학습 파이프라인 (Python)

`scripts/train.py`가 `ugrp_train/` 모듈을 순서대로 부른다:

1. `io.py` — runs/S3에서 NDJSON 로드, **quarantine 창 존중**.
2. `features.py` — 행 → 특징 벡터. `experiment.json`의 캘리브레이션 값(지속 CPU)을 부하
   축에 매핑.
3. `labels.py` — QoE 가중합(LCP .4 / INP .3 / TBT .2 / TTFB .1) + ServerCost,
   **라우트별 z-score 정규화**.
4. `split.py` — 시간 × 라우트 그룹 이중 분할 (세션 누수 방지).
5. `model.py` — LightGBM + 커스텀 pairwise 목적함수 (같은 조건 내 모드 간 순위가 진짜
   목표라서).
6. `distill.py` — 앙상블 → depth-5 트리 JSON (~50KB).
7. `evaluate.py` — regret, 모드 일치율 등 평가 리포트.
8. `config.py` — **JS 쪽 3개 테이블의 수동 복사본** (grid.mjs 조건, features.ts 순서,
   모드 인덱스). 드리프트 감지는 `check:tree`의 몫.

산출된 `out/tree.json`을 `policy/model/tree.v0.json`으로 **수동 복사**하는 것이 배포이고,
그 전에 `check:tree`를 돌리는 것이 규약이다.

---

## 3부. 한눈에 보는 데이터 흐름

```
[수집]  run.mjs ─ measure.mjs(Playwright+CDP) ─→ SUT(/m/모드/유형/slug)
              │                                    │ correlation.ts가 ID 발급
              │ ←── Beacon.tsx(web-vitals) ────────┘
              └─→ NDJSON(S3 또는 runs/) + 체크포인트(DynamoDB 또는 done.jsonl)
[학습]  io → features → labels(z-score) → model(LightGBM) → distill → out/tree.json
[배포]  check:tree 통과 → policy/model/ 복사 → edge 번들 빌드 → CDK 배포
[서빙]  viewer-request(버킷 접기) → 캐시 → miss시 origin-request(decide) → 오리진
```

## 4부. 조용히 지나가는 실패들

이 저장소의 비싼 버그는 예외를 던지지 않는다 — **그럴듯한 숫자와 초록 체크를 내놓는다**.
전체 목록은 각 하위 README에 있고, 패키지를 넘나드는 네 가지만 여기에 적는다:

1. **헤드리스 Chrome을 봇으로 분류.** 모든 워커 요청이 SSR로 핀되어 ssr 대 ssr을 비교하게
   된다. `check:policy`는 통과한다. 첫 4단계 실행에서 실제로 발생했다.
2. **CDP 스로틀링은 Client Hints를 안 바꾼다.** 워커가 `x-cell-*` 헤더를 주입하지 않으면
   모델이 배우려는 두 축이 데이터셋 전체에서 상수가 된다.
3. **`policy/features.ts` ↔ `training/config.py` 특징 순서 드리프트.** 에러 없는
   train-serve skew — 트리는 없는 특징을 0으로 읽고 왼쪽 가지로만 내려간다.
   `npm run check:tree`가 게이트다.
4. **짧은 버스트로 부하 캘리브레이션.** 고정 VU는 동시성을 고정하지 CPU를 고정하지 않는다 —
   지속 CPU가 캘리브레이션보다 12~16%p 낮게 앉고, 부하 축이 서버가 겪지 않은 CPU로
   라벨링된다. `calibrateRemote`가 지속 값을 기록하는 이유다.

수집이 도는 동안 같은 머신에서 CPU 무거운 작업(빌드·학습·typecheck)을 돌리면 idle 셀의
전제가 깨진다. 생기면 행 삭제가 아니라 `quarantine.mjs`로 창을 표시한다.
