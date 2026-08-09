# 학습 파이프라인 (7단계)

`workers/runs/*/results.jsonl`(6단계 수집)을 읽어 라벨을 계산하고, LightGBM 서로게이트를
학습하고, 오라클·기준선 대비 오프라인 평가를 낸다. 제안서 §4·§5.4의 파이썬 구현이다.

## 실행

```bash
pip install -r requirements.txt

python scripts/fetch_routes.py           # 라우트 정적 특징 스냅샷 (앱 서버가 떠 있어야 함)
python scripts/train.py                  # runs/ 아래 모든 실험으로 학습
python scripts/train.py --runs pilot-low-idle --distill --out out/pilot
```

수집이 끝나지 않아도 지금 있는 부분 데이터로 돌아간다 — 표본이 적으면 경고를 내고
계속 진행한다. 파이프라인이 죽었는지 확인하려고 6단계가 끝나기를 기다릴 필요가 없다.

## 구조

```
ugrp_train/
  config.py     기기·네트워크 조건 표, 피처 순서, QoE 가중치 — JS 원본의 사본(아래 참조)
  io.py         runs/*/results.jsonl + route_snapshot.json 적재
  labels.py     J(x,m) = Σw·z_r(QoE) + λ·ServerCost 계산
  features.py   policy/features.ts의 toVector()와 같은 스키마로 피처 행렬 구성
  split.py      시간 + 라우트 그룹 분할, GroupKFold
  model.py      LightGBM(MSE+pairwise 커스텀 목적함수) 학습, 앙상블, 기준선
  evaluate.py   오라클 regret · top-1 · pairwise accuracy (조건 단위)
  distill.py    앙상블 → 깊이 5 트리 → policy/model/*.json 스키마로 내보내기
scripts/
  fetch_routes.py   라우트 스냅샷 생성 (앱에 GET 1회 + bundles.generated.json 읽기)
  train.py          전체 파이프라인 CLI
```

## `config.py`는 사본이지 원본이 아니다

기기·네트워크 조건 표, 피처 순서, 모드 인덱스는 JS 쪽에 원본이 있다:

| Python | JS 원본 |
|---|---|
| `DEVICES`, `NETWORKS` | `workers/lib/grid.mjs` |
| `FEATURE_ORDER` | `apps/benchmark/policy/features.ts`의 `toVector()` |
| `MODE_INDEX` | `apps/benchmark/policy/model/*.json` |

**`FEATURE_ORDER`가 `toVector()`와 어긋나면 train-serve skew가 생긴다.** 학습 때 본
피처 순서와 엣지 추론 시점의 순서가 다르면 트리는 에러 없이 조용히 틀린 값을 낸다.
JS 쪽을 고치면 이쪽도 손으로 맞춰야 한다 — 자동 동기화 장치는 없다.

자동 동기화는 없지만 **검사는 있다**. 트리를 배포하기 전에 앱 쪽에서 돌린다:

```bash
cd ../apps/benchmark && npm run check:tree     # 기본 대상: training/out/tree.json
```

`toVector()`의 키 집합을 `features.ts` 원본에서 직접 읽어 트리의 분기 피처 이름과
대조한다. 여기서 걸리는 것이 위에서 말한 조용한 실패다 — `surrogate.ts`의
`x[cur.feature] ?? 0`은 없는 피처를 0으로 읽고 예외를 내지 않는다.

## 트리 깊이 필드의 정의

`tree.json`의 `maxDepth`는 **분기 레벨 수**다(= 예측 1회당 비교 횟수, sklearn
`get_depth()`와 같은 관례). 노드 레벨 수는 이보다 1 크다. `maxDepthBudget`은
`distill_tree(max_depth=...)`로 준 설정값이고, `maxDepth`는 실제로 자란 깊이라
데이터가 얕으면 예산보다 작게 나온다. 둘을 섞으면 예산을 넘긴 트리가 준수한 것처럼
보이므로 `check:tree`가 둘 다 대조한다.

## 라벨 계산이 원본 공식과 다른 지점

`J(x,m) = Σ w_i·z_r(QoE_i) + λ·ServerCost(x,m)`은 제안서 §3.1 그대로다. `ServerCost`만
근사가 들어간다.

**missRate 공식(`1/max(1, rps_r·T)`) 대신 관측된 렌더 여부를 직접 쓴다.** 이 공식은
해당 라우트의 실제 요청률이 있어야 하는데, 배경 부하가 측정 라우트를 일부러 피해
가도록 설계돼 있어(`load/profile.json`) 측정 라우트의 `rps_r`은 사실상 이 측정
요청 하나뿐이다 — 공식이 무의미하다. 대신 각 행이 실제로 렌더를 유발했는지
(`serverRenderCount`>0)를 직접 관측해, Idle·렌더 발생 표본의 평균(`C_render(m, routeType)`)을
그 행에 곱한다. 캐시 축이 miss/hit/stale로 이미 셀 정의에서 분리돼 있으므로, 한 셀
반복들의 렌더-발생 비율이 그 조건의 경험적 missRate와 같다.

**개별 행의 `serverRenderCpuUs`를 직접 쓰지 않는다.** Windows에서 15.625ms 단위로
양자화되어 수 ms짜리 렌더가 대부분 0으로 잡힌다(CLAUDE.md). `measure:render`가 하는
것과 같은 N-반복 평균으로 상쇄한다 — 이 처리가 없으면 라벨의 ServerCost 항이 거의
전부 0이 되어 사실상 QoE 항만 학습하게 된다.

**C_serve·C_store는 0이다 — 근사가 아니라 미계측이다.** 캐시 히트 시 서빙 비용과
캐시 엔트리 크기를 재는 계측이 아직 없다. `μ`가 실측되기 전까지 `C_store` 항은
라벨에 반영되지 않는다.

**λ는 스윕 대상이지 정답이 아니다.** 제안서 §3.3에 따르면 λ는 배포 후 이중 상승법
(dual ascent)으로 예산 B에 맞춰 조정되는 그림자 가격이지, 오프라인 학습 시점에
고정할 값이 아니다. 운영 예산 B가 아직 정해지지 않았으므로 `--lambda`로 스윕 가능한
기본값(1.0)만 둔다.

## pairwise 손실의 그룹 키

`L = L_MSE + α·Σ_{(i,j)∈M(x)²} hinge(...)`에서 "같은 x"는 **모드를 뺀 조건**
(device, network, load, routeType, routeKey)이다. 반복(rep)은 그룹 키에 넣지 않는다
— 여러 모드를 같은 시점에 나란히 측정한 게 아니라(`run.mjs`는 셀 단위로 돈다) 모드별로
독립된 반복을 모은 것이므로, 특정 반복끼리 짝지을 근거가 없다. 대신 반복을 `J(x,m)`의
노이즈 있는 실현치로 보고, 같은 x 아래 모드가 다른 행이면 무엇이든 비교 대상으로 삼는다.

## 알려진 한계

- **필드 데이터가 없다.** `deviceMemory`·`hardwareConcurrency`·`prevLcpMs`·`prevTbtMs`·
  `isRepeatVisit`은 랩 수집이 시뮬레이션하지 않는 값이라 전부 고정 기본값이다
  (`config.LAB_FEATURE_DEFAULTS`). 10단계 필드 무작위화 로그가 이 공백을 채운다.
- **`cacheHitRate`·`routeRps`·`inflight`가 항상 0이다.** 랩 수집은 전역 캐시 적중률이나
  실제 요청률을 재현하지 않는다. `cpuPct`·`eventLoopP95Ms`만 실험의 `calibration` 블록에서
  부하 수준별 실측값을 가져온다.
- **C_store가 항상 0.** 위 참조.
