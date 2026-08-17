# 측정 인프라 (AWS CDK)

전체 그리드는 **10,400셀 × 30반복 = 813시간**(단일 프로세스 직렬)이다. 34일이다.
이걸 줄이는 유일한 방법이 병렬화인데, 로컬에서는 불가능하다 — `run.mjs`가 부하
생성기를 프로세스 안에 소유하고 SUT가 하나뿐이라, 두 워커가 같은 서버를 때리면
서로의 부하 수준을 망가뜨린다. **부하는 외생이어야 한다**는 제안서 §5.3의 전제가
곧 로컬 직렬성의 원인이다.

여기서의 답: **(SUT + k6 + 워커) 한 벌을 통째로 복제한다.** 그 한 벌이 샤드이고,
샤드끼리는 아무것도 공유하지 않는다. 공유하지 않는 것이 무엇인지가 스택 모양을
전부 결정한다.

```
샤드 i ─┬─ SUT 태스크        (Fargate, desiredCount 고정, 오토스케일 없음)
        ├─ k6 태스크         (Fargate, 캘리브레이션된 VU로 고정)
        └─ Playwright 워커   (Fargate, 자기 몫의 셀만 측정)
```

20샤드 기준 **벽시계 40.7시간**, 불균형 1.000. 총 작업량은 줄지 않으므로
(813 코어-시간은 그대로) 비용은 샤드 수와 거의 무관하다.

## 실행

```bash
npm install
npm run typecheck
npm run synth                       # cdk.out/에 템플릿 생성 — 계정 없이도 된다
npm run deploy -- --all             # 자격증명 필요
```

수집 운영은 `scripts/`의 셋으로 한다 — 각 파일 머리 주석이 그 절차를 만든 사고를 적고 있다:

```bash
./scripts/push-images.sh [sut|worker|load]   # 빌드 → ECR → 다이제스트 출력(cdk.json에 붙여 커밋)
./scripts/start-collection.sh                # Shards+Orchestration 배포 → 전 서비스 1로 강제·안정화 대기 → SFN 시작
./scripts/watchdog-grid.sh <execution-arn>   # 20분 심박, 이탈·무진행·종료 시 exit — exit가 곧 신호
./scripts/resume-shards.sh 15 18             # 일부 샤드만 재개 — SFN 없이 워커 RunTask 직접(끝나면 서비스 0은 수동)
```

컨텍스트로 규모를 바꾼다:

```bash
npx cdk synth -c ugrp:shardCount=40 -c ugrp:experiment=grid-v2
```

## 구성

| 파일 | 역할 |
|---|---|
| `lib/config.ts` | 리전·태스크 크기·이미지 다이제스트·수집 파라미터 |
| `lib/network-stack.ts` | VPC, VPC 엔드포인트, 보안 그룹 3종 |
| `lib/data-stack.ts` | S3 결과 버킷, DynamoDB 체크포인트, ECR 3종 |
| `lib/shard-stack.ts` | ECS 클러스터, 샤드별 SUT·부하 서비스와 워커 태스크 정의 |
| `lib/orchestration-stack.ts` | Step Functions — 샤드 부채꼴 실행 |
| `lib/serving-origin-stack.ts` | 공개 ALB + SUT (필드 오리진) |
| `lib/serving-stack.ts` | CloudFront + Lambda@Edge (정책 서빙 평면) |
| `scripts/push-images.sh` | 이미지 3종 빌드·푸시 후 다이제스트 출력 |
| `scripts/resume-shards.sh` | 잘린 샤드만 재개 — 72h 태스크 타임아웃에 죽은 grid-v1 high 샤드 2개가 계기 |
| `bin/ugrp.ts` | 앱 진입점 |

Dockerfile은 각 컴포넌트 옆에 있다 — `apps/benchmark/Dockerfile`, `workers/Dockerfile`,
`load/Dockerfile`. 빌드 컨텍스트는 셋 다 `03_Project/`다(워커 이미지가 `load/`를 함께 담는다).

분할 규칙은 여기 없다. `workers/lib/shard.mjs`에 있다 — 어느 셀을 어느 샤드가
쟀는지는 **실험 정의**이지 배포 설정이 아니고, 재현되지 않으면 샤드 간 하드웨어
편차를 사후에 통제할 수 없다.

## 제안서와 다른 지점 — 명시

**랩 수집 경로에는 ALB도 CloudFront도 두지 않는다.** 제안서 §5.1은 SUT를
"ALB + CloudFront 뒤의 ECS Fargate"로 기술하지만, 그건 **필드 실험의 토폴로지**다.
랩 factorial 수집에서는 세 가지 이유로 빼는 것이 맞다:

1. 측정 대상은 SUT가 고정된 모드·고정된 부하에서 어떻게 렌더하느냐다. ALB는 홉을
   하나 더하면서 자기 분산을 얹는데, 실험적으로 얻는 것이 없다.
2. CloudFront의 캐싱이 캐시 상태 축(miss/hit/stale)을 교란한다. §3.1.2의
   `missRate`를 관측하려고 만든 축이 CDN 뒤에서는 관측되지 않는다.
3. ALB는 샤드마다 필요하고 20개면 컴퓨트 전체보다 비싸다.

대신 워커·k6는 Cloud Map 사설 DNS로 자기 샤드의 SUT에 직접 붙는다. 네트워크
조건은 어차피 CDP로 에뮬레이션하므로, 그 아래 실제 경로는 짧고 일정할수록 좋다.

CloudFront + Lambda@Edge는 **정책 서빙 평면**에서 여전히 필요하다(제안서 §4.1).
그건 이 스택이 아니라 별도 스택이고, 랩 수집과 요구사항이 다르다.

## 왜 이렇게 했는가

**단일 AZ.** 네트워크 조건은 CDP로 만들지만 그 아래 실제 RTT는 노이즈 바닥이다.
워커와 SUT가 AZ를 넘으면 0.5~1ms가 더해지고 그 편차가 매 측정에 실린다. 가용성보다
측정 안정성이 우선인 인프라다. 인터페이스 엔드포인트 비용이 절반이 되는 건 덤이다.

**NAT 게이트웨이 없음.** 태스크가 인터넷에 나갈 이유가 없다 — 이미지는 ECR, 결과는
S3, 체크포인트는 DynamoDB고 전부 VPC 엔드포인트로 닿는다. 시간당 요금에 GB당
요금이 붙는데 샤드 20개가 1.5GB짜리 Playwright 이미지를 각자 당긴다. 인터넷 경로가
없다는 것은 측정이 외부 요인에 노출되지 않는다는 뜻이기도 하다.

**워커와 부하 생성기는 다른 서브넷·다른 SG**(제안서 §5.3). 둘 사이에는 규칙을
추가하지 않는다 — 열어두면 부하가 워커 쪽으로 새어도 드러나지 않는다.

**이미지는 sha256 다이제스트로만 참조한다.** `:latest`는 재현성 요구사항상 실격이다.
`config.ts`의 `requireDigests()`가 합성 단계에서 막는다. ECR 저장소도
`IMMUTABLE` 태그라, 같은 태그가 나중에 다른 바이트를 가리키는 일 자체가 불가능하다.

**S3·DynamoDB·ECR은 RETAIN.** 813 코어-시간을 들여 모은 데이터를 `cdk destroy`
한 번으로 지울 수 있게 두지 않는다.

## 배포 순서

```bash
npm run deploy -- Ugrp-grid-v1-Network Ugrp-grid-v1-Data   # ECR 저장소가 먼저 있어야 한다
./scripts/push-images.sh                                    # 다이제스트를 찍어준다
# 출력된 ugrp:digests 를 cdk.json 에 붙여넣고 커밋
npm run deploy -- --all
```

다이제스트가 없으면 샤드 스택은 **만들어지지 않는다**(합성 시 이유를 알린다).
자리표시자를 채워 합성만 되게 하면 그 가짜 값이 템플릿에 들어간 채 배포될 수 있어서,
스택을 아예 만들지 않는 쪽을 골랐다. 네트워크·데이터 평면은 다이제스트 없이 합성되므로
구조 검증은 그대로 된다.

### 워커 이미지를 바꿀 때는 Orchestration을 먼저 지운다

이미 배포된 스택에서 **워커 다이제스트만 갈아끼우는 배포는 실패한다.**

```
Update canceled. Cannot update export Ugrp-grid-v1-Shards:ExportsOutputRefWorkerTask01…
as it is in use by Ugrp-grid-v1-Orchestration.
```

Orchestration의 `EcsRunTask`가 워커 태스크 정의 ARN을 export로 소비하는데, 이미지가
바뀌면 태스크 정의가 새로 만들어져 그 export 값이 바뀐다. CloudFormation은 **사용 중인
export의 값 변경을 거부한다.** `cdk.json`의 `defaultCrossStackReferences: strong`이
설계대로 동작한 것이다 — 소비 중인 참조가 끊기는 사고를 막는 대신 이 대가를 치른다.
두 스택을 한 번에 배포해도 소용없다(같은 트랜잭션이 아니다).

```bash
npx cdk destroy Ugrp-grid-v1-Orchestration --force -c …   # 상태 기계뿐이라 잃을 것이 없다
npx cdk deploy Ugrp-grid-v1-Shards Ugrp-grid-v1-Orchestration -c …
```

**상태 기계 ARN이 바뀐다.** 진행 점검 스크립트에 ARN을 박아 두었다면 함께 갱신한다.
수집 데이터는 영향받지 않는다 — 결과와 체크포인트는 Data 스택에 있고, 같은 `--name`으로
다시 실행하면 완료된 셀을 건너뛴다.

### CloudFormation은 `desiredCount`를 되돌려 주지 않는다

서비스를 손으로(또는 실패 시 자동 축소 Lambda가) 0으로 내리면, 템플릿이 안 바뀐 서비스는
재배포해도 **0인 채로 남는다** — 드리프트는 CFN의 관심사가 아니다. grid-v1 3차 시도가
그렇게 죽었다(load-04가 0 → 워커의 첫 `/vus`가 fetch failed → 1분 만에 SFN 실패).
그래서 `start-collection.sh`는 배포 뒤 전 서비스를 명시적으로 1로 놓고 `services-stable`을
기다린 다음에야 실행을 시작한다. 실행 시작은 이 스크립트로만 한다.

### 실행이 죽으면 서비스는 스스로 0이 된다

Orchestration 스택에 EventBridge 규칙(SFN FAILED/TIMED_OUT/ABORTED) → Lambda가 있어
클러스터의 모든 서비스를 `desiredCount=0`으로 내린다. 1차 시도 때 실패~발견 사이 4시간
동안 60개 태스크가 놀며 ~$20를 태운 뒤에 넣었다. 감시 스크립트가 로컬에서 죽어도(재부팅,
세션 종료) 무인 실패의 비용은 분 단위로 끝난다.

## 규모

| 샤드 | 벽시계 | 샤드 스택 리소스 |
|---|---|---|
| 20 | 40.7시간 | 149 |
| 40 | 20.4시간 | 289 |
| 70 | 11.6시간 | 499 — 한도 직전 |

리소스 수는 **9 + 7n**이다(실측: 1샤드 16, 2샤드 23, 20샤드 149). CloudFormation 스택
한도가 500이므로 **한 스택에 70샤드까지** 들어간다. 역할(실행·태스크)을 샤드마다 만들지
않고 공유해서 나온 수다 — 나누면 샤드당 리소스가 세 배가 되어 20샤드대에서 한도에 닿는다.
샤드는 같은 이미지로 같은 일을 하는 복제본이라 권한이 다를 이유가 없고, 격리해야 하는
SUT는 태스크 단위로 이미 갈라져 있다.

> 이 표의 이전 값(109 / 209, 샤드당 5리소스, 90샤드)은 실측이 아니라 추정이었다.
> 다이제스트가 없어 샤드 스택이 합성되지 않던 동안 세어볼 수 없었기 때문이다.

## 캘리브레이션과 부하 제어

`load/calibration.generated.json`의 VU 수(low 6 / mid 30 / high 71)는 18코어 머신에서
1코어를 할당한, 목표가 아직 30/65/90이던 시절의 값이다. Fargate 2 vCPU에서는 다른 값이
나오고(grid-v1 실측: low VU 40–56, mid 96–192, high 512 상한에서 63.8–68.9%), 그대로
쓰면 부하 수준이 그리드가 말하는 것과 다른 값이 된다. 그래서 **워커가 실행 시점에 다시
잡는다.** 목표가 30/50/70인 이유와 high가 천장에 걸리는 이유는 `load/README.md`.

부하 생성기는 `load/control.mjs`로 뜨고 VU 0에서 지시를 기다린다. 워커가
`LOAD_CONTROL_URL`로 VU를 놓고 SUT의 `/api/internal/metrics`를 읽으며 이진 탐색한다 —
CPU를 읽는 쪽이 워커이므로 탐색도 워커에 있는 것이 자연스럽다. 결과는
`runs/<실험>/calibration.observed.json`에 남는다(`experiment.json`은 재개 시
덮어쓰지 않는 것이 규칙이라 별도 파일이다).

**측정 중에는 VU를 얼린다.** 부하 생성기에 목표 CPU를 주고 스스로 맞추게 하면 부하가
측정 요청에 반응하는 제어 루프가 되어 외생성이 깨진다.

대신 워커가 셀마다 실측 CPU를 확인하고 각 행에 `serverCpuPct`로 남긴다. **이게 없으면
조용히 망가진다** — 행의 `vus`는 설정값이라 부하 생성기가 죽어도 `vus: 30`이 남고
서버는 놀고 있다. 3회 연속 ±12%p를 벗어나면 멈춘다. 관측하고 멈출 뿐, 보정하지 않는다.

## 결과 회수

Fargate 태스크에는 남는 디스크가 없다. 워커는 `UGRP_RESULTS_BUCKET`·
`UGRP_CHECKPOINT_TABLE`이 있으면 S3 + DynamoDB로 쓴다(`workers/README.md` 참조).
수집이 끝나면 학습 쪽으로 가져온다:

```bash
aws s3 sync s3://<버킷>/experiment=<실험>/ 03_Project/workers/runs/<실험>/
cd 03_Project/training && python scripts/train.py --runs <실험> --distill
```

## 수집이 끝나면 — 정리 순서

샤드는 서로 독립이라 **먼저 끝난 샤드의 SUT·부하 서비스는 실행 중에도 0으로 내려도 된다**
(high 샤드가 항상 꼬리라, 나머지 15개를 세워 두면 시간당 ~$5가 헛돈다):

```bash
CLUSTER=$(aws ecs list-clusters --query "clusterArns[?contains(@,'Ugrp-grid-v1-Shards')]|[0]" --output text)
aws ecs update-service --cluster "$CLUSTER" --service <Sut07Service…> --desired-count 0   # Load07도 같이
```

실행이 끝나면(SFN SUCCEEDED/FAILED) Orchestration → Shards 순으로 지운다. Data(S3·DynamoDB·
ECR — RETAIN)와 Network는 남긴다; 재실행·다른 실험은 같은 Data 위에 올린다.

```bash
npx cdk destroy Ugrp-grid-v1-Orchestration Ugrp-grid-v1-Shards --force
```

grid-v1 실측 비용: 20샤드 온디맨드 ~$6.3/h(전 샤드 가동 시), 6차 실행 ~78h(꼬리 포함 — 72h 태스크 타임아웃에 걸려 high 샤드 2개는 `resume-shards.sh`로 8/17 재개) +
사전 시도·파일럿 ≈ **$440**. 제안서 추정(41–48h, $282–343)과의 차이는 (1) 5차례 실패한
시도의 유휴 과금 (2) high 샤드 꼬리 ~1.5일 — high 셀은 표본 실패 재시도로 다른 수준의
2배 이상 느리다. 다음 실험은 high 샤드 수를 늘려 꼬리를 나누는 것이 벽시계·비용 모두에서
이득이다(`lib/shard.mjs`가 실험 정의이므로 그 변경도 커밋에 남긴다).

## 정책 서빙 평면

랩 수집과 독립이라 플래그를 줄 때만 만들어진다. 수집만 돌릴 때 CloudFront
전파(수십 분)를 기다릴 이유가 없다. **두 단계로 배포한다** — CloudFront가 오리진
도메인을 알아야 하는데 그 값은 오리진 스택을 배포해야 나온다.

```bash
# 1) 공개 오리진 (ap-northeast-2). CloudFront 프리픽스 리스트 ID가 필요하다:
aws ec2 describe-managed-prefix-lists --region ap-northeast-2 \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
npx cdk deploy Ugrp-grid-v1-ServingOrigin \
  -c ugrp:serveOrigin=true -c ugrp:cloudfrontPrefixList=pl-xxxxxxxx
# → OriginDomainName 출력값을 받는다

# 2) 엣지 (us-east-1)
cd ../edge && npm run build -- --origin https://<위 도메인> && npm test
cd ../infra && npx cdk deploy Ugrp-grid-v1-Serving -c ugrp:servingOrigin=<위 도메인>
```

리전 간 자동 참조(`crossRegionReferences`)로 이을 수도 있지만, 커스텀 리소스
람다가 양쪽 리전에 생기고 스택 삭제가 까다로워진다. 두 단계면 **어떤 오리진으로
배포했는지가 명령에 그대로 남는다.**

**us-east-1 고정.** Lambda@Edge를 만들 수 있는 유일한 리전이라 엣지 스택만 리전이
다르다. 오리진은 ap-northeast-2에 있어도 되고, 엣지 함수는 배포 후 전 로케이션에
복제된다. 다른 리전으로 합성하면 스택이 이유를 알리고 멈춘다.

캐시 키 설계 근거는 `edge/README.md`에 있다.

### 서빙 오리진이 랩 VPC를 쓰지 않는 이유

랩 VPC에 인터넷 게이트웨이를 달면 "랩 경로에는 인터넷 경로가 없어 측정이 외부
요인에 노출되지 않는다"는 근거가 무너진다. 별도 VPC를 만들고, 랩 VPC는 IGW·NAT
모두 0으로 유지한다.

랩과 다른 선택 셋:

- **AZ 2개.** 랩은 측정 안정성 때문에 1개였지만, 여기는 실사용자를 받는 경로라
  가용성이 우선이다.
- **공개 서브넷 + 공개 IP, NAT 없음.** NAT는 AZ당 시간당 요금이 붙는데 얻는 것은
  "태스크에 공개 IP가 없다"뿐이다. 인그레스는 SG가 ALB로만 막으므로 실질적 노출
  차이가 없다.
- **ALB 인그레스는 CloudFront 관리형 프리픽스 리스트로만 연다.** 이건 보안 이전에
  실험 무결성 문제다 — ALB를 직접 때릴 수 있으면 그 요청은 결정 계층을 건너뛰고,
  정책이 적용되지 않은 관측이 필드 로그에 섞이는데 사후에 구분할 수 없다.

**오토스케일은 켜지 않는다.** 부하가 오르면 태스크가 느는 구조에서는 서버 부하
피처가 정책의 결정에 반응하게 되어, 랩에서 부하를 외생으로 고정한 이유가 필드에서
그대로 무너진다. 용량(`-c ugrp:servingTasks`)은 실험 조건이다.

## 아직 없는 것

- Parquet 변환. 지금은 S3에 NDJSON으로 쌓인다. 제안서 §5.4의 Firehose → Parquet는
  필드 수집 경로이고, 랩 수집은 워커가 직접 쓴다. 셀당 객체 하나(총 1만 개 남짓)라
  Athena로 바로 읽어도 부담이 없지만, 규모가 커지면 Glue 변환이 필요하다.
