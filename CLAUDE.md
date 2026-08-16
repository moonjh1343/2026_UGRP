# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

Every plane below is implemented and tracked — SUT, load generator, measurement workers, CDK
infrastructure, edge serving plane, training pipeline. What is missing is a **trained model**:
the full-grid collection (`grid-v1`, 20 Fargate shards) started 2026-08-14 and its data lives
in S3 + DynamoDB, not under `workers/runs/`; the tree the policy actually serves is still the
`v0-unfitted` placeholder until stage 7 runs on that data.

| 단계 | 상태 |
|---|---|
| 1–4 골격 · 계측 · 유형 확대 · 결정 계층 | 완료 (`check:dom`·`check:join`·`check:divergence`·`check:policy` 통과) |
| 5 부하·측정 워커 | 완료 (`verify-variance.mjs` 통과, n=30) |
| 6 factorial 수집 | 본수집 `grid-v1` 2026-08-14 시작(10,400셀·20샤드) — 8/16 기준 97%, high 부하 샤드 2개가 꼬리. 데이터는 S3(`UGRP_RESULTS_BUCKET`)·체크포인트는 DynamoDB. `workers/runs/pilot-low-idle/`·slice-b2는 그 이전 파일럿(SSG 캐시 축은 revalidate no-op 버그로 의심 대상) |
| 7 학습 파이프라인 | 배선 완료, 학습된 모델 없음 (`policy/model/tree.v0.json` = `v0-unfitted`) |

Anything under `training/out/` is a smoke-test artifact until stage 6 finishes —
`eval_report.json` currently scores n=2 conditions. Do not read it as a result.

All commands in this section run from `03_Project/apps/benchmark/`:

```bash
npm run build && npm start     # 측정은 프로덕션 빌드로만. dev 서버는 요청 시 컴파일한다
npm run typecheck
```

Verification scripts require a running server. Each gates one implementation stage:

| 명령 | 검증 | 단계 |
|---|---|---|
| `npm run check:dom` | 5개 모드의 최종 DOM이 동일한가 | 1 |
| `npm run check:join` | 서버 레코드 ↔ 클라이언트 비콘이 조인되는가 | 2 |
| `npm run check:divergence` | 유형별 모드 우열이 서로 다른 방향인가 | 3 |
| `npm run check:policy` | 정책 교체가 앱에 영향 없는가 / 추론 < 2ms인가 | 4 |
| `npm run check:tree` | 학습된 트리가 `policy/model/`에 들어갈 모양인가 | 7 |
| `npm run check:determinism` | 페이로드가 바이트 단위로 동일한가 | — |
| `npm run analyze:routes` | 모드별 번들 KB 룩업 테이블 생성 (→ 재빌드) | — |
| `npm run measure:render` | `C_render(m)` 반복 집계 | — |
| `npm run inspect:graph` | 모드별 클라이언트 그래프 내용 (Islands에 트리가 없어야 함) | — |
| `npm run report:bundles` | 모드별 HTML·JS 전송량 | — |

Stage 5 lives outside the app. `workers/` has its own `package.json` (`npm install` there);
`load/` has no dependencies and runs on plain node.

```bash
cd 03_Project/load && node calibrate.mjs               # 목표 CPU → VU 이진 탐색
cd 03_Project/workers && npm install
node verify-variance.mjs --reps 30 --types content,dashboard,form   # 5단계 합격 기준
node run.mjs --name pilot --reps 30 --loads idle --types content    # 한 슬라이스만 수집
node diagnose-tail.mjs --type content                  # 이상치 제거율이 튀는 원인 진단
npm run test:checkpoint                                # 클라우드 체크포인트 (가짜 AWS 클라이언트)
```

There is no per-test runner here — **the grid is the test suite**, and narrowing it is how you
run one case: `run.mjs` takes `--devices --networks --loads --types --routes --modes --cache
--reps --warmup --seed`, plus `--shard-index/--shard-count`. `--skip-stale` is a verification
escape hatch, not a collection option (each `stale` rep costs ~62s and that cost is the point).

k6 is not installed in this environment; `load/generator.mjs` is the local stand-in and reads
the same `load/profile.json` as the k6 deployment script.

Stage 6 (factorial collection) runs `run.mjs` against slices of the 10,400-cell grid; a
run is resumable by re-invoking with the same `--name` (see `workers/README.md`).

**While a collection is running, do not run anything CPU-heavy on this machine** — training,
builds, typechecks. Background load is supposed to be exogenous, and CPU spent beside the
measurement makes an `idle` cell's "no background load" false. If it happens anyway, mark the
window instead of deleting rows: `node quarantine.mjs --name <run> --from <ISO> --to <ISO>
--reason "..."`. `io.load_runs()` honors those windows, and `--requeue` (after collection
stops) drops only cells left with too few surviving reps. Stage 7
(training pipeline) is a separate Python package at `03_Project/training/`:

```bash
cd 03_Project/training
pip install -r requirements.txt
python scripts/fetch_routes.py     # route snapshot — needs the app server up, doesn't disturb it
python scripts/train.py --distill  # load collected runs → label → train → evaluate → distill
python scripts/train.py --runs pilot-low-idle --distill --out out/pilot   # 한 실험만
```

It runs on partial data on purpose — too few samples produces a warning, not a failure, so you
never have to wait for stage 6 to finish to find out the pipeline is broken.

Parallel collection infrastructure is a CDK app at `03_Project/infra/` (`npm run synth` works
without AWS credentials). The full grid is 813 hours serial; 20 shards bring it to 40.7. A shard
is one **(SUT + k6 + worker) triple** — nothing is shared between shards, because two workers
hitting one SUT would break each other's load level. The partitioning rule lives in
`workers/lib/shard.mjs`, not in the CDK app: which shard measured which cell is experiment
definition, and without it you cannot control for per-shard hardware variance after the fact.
See `infra/README.md` for the deviations from the proposal's topology (no ALB/CloudFront in the
lab path) and why.

```bash
cd 03_Project/infra && npm install
npm run typecheck
npm run synth                      # no credentials needed
npx cdk synth -c ugrp:shardCount=40
```

The collection runbook is `infra/scripts/` — read the header comments, each records a failure
that shaped it:

```bash
./scripts/push-images.sh [sut|worker|load]   # build → ECR → prints digests; paste into cdk.json and commit
npx cdk destroy Ugrp-grid-v1-Orchestration --force   # required before a Shards update that changes a worker digest (export lock)
./scripts/start-collection.sh                # deploy Shards+Orchestration, force every service to 1 and wait, start SFN
./scripts/watchdog-grid.sh <execution-arn>   # 20-min heartbeat; exits on stall/drift/end — exit is the signal
```

`cdk.json`'s `ugrp:digests` is experiment metadata: the worker image contains `load/`, so
changing the load generator changes the worker digest too. The digest bump is its own commit.
The watchdog runs on the operator's machine and dies with it (reboot, session end) — the
collection does not, and an EventBridge→Lambda rule scales all services to 0 if the SFN
execution fails, so an unattended failure costs minutes, not hours. Finished shards' SUT/load
services can be scaled to 0 by hand while others still run — shards are independent.

**`run.mjs` is one binary for both worlds; three environment variables decide which.**
`LOAD_CONTROL_URL` switches the load generator from in-process (stored calibration) to a
remote task whose VU count is re-searched at run time — a VU count calibrated on one machine
does not mean the same load on Fargate. `UGRP_RESULTS_BUCKET` + `UGRP_CHECKPOINT_TABLE` switch
JSONL-under-`runs/` to S3 + DynamoDB, and supplying only one of the pair is rejected: results
and done-markers in different places means resume is not resume. Shard flags do the rest.
Keeping this in env vars rather than a separate cloud runner is what makes the local pilot and
the 20-shard run the same experiment.

The serving plane is two stacks deployed in that order: `ServingOrigin` (public ALB + SUT in
`ap-northeast-2`, `-c ugrp:serveOrigin=true`) then `Serving` (CloudFront + Lambda@Edge in
`us-east-1`, `-c ugrp:servingOrigin=<the ALB DNS>`). It has its own VPC — putting an internet
gateway in the lab VPC would void the claim that lab measurements have no internet path. The
ALB accepts only the CloudFront prefix list: a request that reaches the origin directly skips
the decision layer, and that observation is indistinguishable from a policy-served one
afterwards. The edge code lives in `03_Project/edge/`. Build its bundle first
(`cd 03_Project/edge && npm run build -- --origin https://<origin>`; `npm test` runs the
handlers against real CloudFront event shapes). **The cache key is the whole design**: a
CloudFront Function folds client hints into `x-ugrp-bucket`, that header — and only that
header — is in the cache key, and the model runs at origin-request so cache hits pay nothing.
Read `edge/README.md` before touching it; both the bucket scheme and the decision to bake the
tree into the bundle instead of AppConfig are load-bearing and depart from the proposal.

`training/ugrp_train/config.py` mirrors JS-side tables (`workers/lib/grid.mjs`'s device/network
conditions, `policy/features.ts`'s feature vector order, `policy/model/*.json`'s mode index) —
those copies don't auto-sync; see `training/README.md` for what breaks if they drift.
`npm run check:tree` is the gate that catches the drift: a tree whose feature name is missing
from `toVector()` raises nothing at serving time — `surrogate.ts`'s `x[cur.feature] ?? 0` sends
every request down the left branch instead. Run it on `training/out/tree.json` before copying
that file over `policy/model/tree.v0.json`. It touches no server, so it is safe during collection;
the swap itself is not — it needs a rebuild and restart, which kills a running run.

Working language is Korean. Documents, comments, and discussion are in Korean; keep new prose in Korean unless asked otherwise.

## What the project is

**Context-adaptive rendering mode selection.** Web frameworks fix the rendering mode (CSR/SSR/SSG/ISR/Streaming SSR/Islands) per route at build time. This research treats the optimal mode as a *function of runtime environment* — client device tier, network quality, and instantaneous server load — and learns a policy that picks the mode per request/session.

Two documents define the system; read them before doing design work:

- `adaptive-rendering-research-proposal.md` — the full spec (32KB). Formalization, ML design, AWS infrastructure, evaluation. **This is the authoritative document.**
- `03_Project/docs/benchmark-app-design.md` — the SUT structure derived from it: 5-mode routing, the shared-component-graph mechanism, instrumentation, and the measurement pitfalls.

## Design decisions already made

These were argued for in the proposal. Do not silently re-litigate them; if you think one is wrong, say so explicitly.

- **Surrogate regression + argmin, not direct classification.** The model predicts cost `Ĵ(x, m)` per mode and the policy takes the argmin. Classification was rejected because it requires hand-defined labels and cannot express "the modes are close enough that switching isn't worth it." Mode switching has fixed costs (cache fragmentation), so the margin between top-1 and top-2 predictions is load-bearing.
- **λ is a shadow price, not a hyperparameter.** The QoE-vs-server-cost tradeoff is reformulated as constrained optimization (minimize QoE cost subject to `E[ServerCost] ≤ B`), with λ adjusted online by dual ascent.
- **Labels are z-score normalized per route.** Skipping this makes the model learn "heavy page = bad" and destroys the between-mode signal that is the actual target.
- **Full-factorial lab collection to sidestep the counterfactual problem.** Lab conditions are reproducible, so every mode is measured under the same condition vector — a request is not limited to one observed treatment. Grid: device tier (4) × network (5) × server load (4) = 80 conditions, times the per-route feasible modes `Σ|M(r)| = 110` plus the SSG cache-state axis (10 SSG routes × 2 extra states) — `80 × (110 + 20) = 10,400` cells, 30 reps each. Mode is not a free 5-way factor: `M(r)` excludes SSG on dashboard/form/personalized, and a policy that folds an infeasible mode into a feasible one silently is unusable as a baseline, so `decide()` records the fallback as `x-decision-reason: infeasible` instead. Field randomization (5–10% of traffic, propensity logged) supplies unbiased data for off-policy evaluation.
- **Background server load must be exogenous.** The render mode itself changes server load, which is also a feature. Load is pinned by a k6 generator with autoscaling disabled and `desiredCount` fixed; a single measurement request rides on top.
- **In-process edge inference only.** A depth-5 tree distilled from the LightGBM ensemble is evaluated inside Lambda@Edge (~50KB JSON). A SageMaker endpoint in the request path would add tens of ms and cancel out the improvement it is measuring. Target overhead: TTFB increase < 2 ms.
- **Server-state features are intentionally stale (~30s).** Load doesn't swing per-second, and a DynamoDB round-trip per request costs more than the freshness is worth.
- **ML never decides SEO or correctness.** Crawler UAs and payment/auth routes are hard-pinned to SSR. A circuit breaker reverts all traffic to the default mode (Streaming SSR) on hydration-error or 5xx spikes.

## Architecture

Five planes as specified by the proposal. Read this list as the *target*; the subsection after
it records where the built system deliberately departs from it.

1. **SUT** — Next.js App Router on ECS Fargate behind ALB + CloudFront, implementing all five render modes in one codebase. Task cpu/memory are experiment variables. ElastiCache holds mode-keyed caches; DynamoDB holds session profiles and bandit state.
2. **Client measurement** — AWS Batch/Fargate Playwright workers driving CDP (`Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions`) for ~95% of cells, real multi-region workers for true RTT (origin pinned to `ap-northeast-2`), EC2 + `tc`/netem where kernel-level control is needed, and Device Farm for a ~5% real-device calibration subset.
3. **Load injection** — k6 on Fargate Spot, on a separate subnet/security group from measurement workers. VU count is binary-searched to hit target CPU (proposal: 30/65/90 %; built system: 30/50/70 %, see below) and then frozen into the cell definition.
4. **Data plane** — `web-vitals/attribution` in the worker → `sendBeacon` → Kinesis Firehose → S3 Parquet (partitioned by date and experiment id) → Glue/Athena.
5. **Training/serving** — SageMaker (Processing → Training → HPO → Model Registry) → distilled tree → AppConfig → Lambda@Edge.

Orchestration is Step Functions Distributed Map over the cell grid, with per-cell checkpointing in DynamoDB so a run can be stopped and resumed.

**The correlation-ID join is the integrity-critical path.** The render decision happens at the edge and the measurement happens in the browser; if those two records can't be joined, the dataset is worthless. Treat any change touching it accordingly.

### Where the built system departs from that list

Each of these was argued for in the sub-README named beside it. Do not "fix" one back toward
the proposal without reading that argument — and do not go looking for the service: it is not
deployed anywhere.

- **No SageMaker.** Training is a local Python package (`training/`, LightGBM + custom pairwise objective), and distillation writes `out/tree.json` for a manual copy into `policy/model/`. Processing → HPO → Model Registry buys nothing while the pipeline is being debugged against a pilot slice.
- **No Firehose/Parquet in the lab path.** Workers write NDJSON straight to S3, one object per cell (`experiment=/dt=/shard=/<cell>.jsonl`, ~10k objects total), and Athena reads that as-is. Firehose → Parquet is the *field* path (proposal §5.4) and is unbuilt. `infra/README.md`
- **No ElastiCache, no bandit state.** Mode-keyed caching is Next's own ISR cache; the single DynamoDB table holds cell checkpoints, not session profiles. The bandit extension is month-6 work.
- **No AppConfig.** The distilled tree is baked into the edge bundle and model replacement is a deploy; Lambda@Edge has no environment variables to point at AppConfig with, and a fetch on cold start would sit in the request path. Fast rollback is the circuit breaker's job. `edge/README.md`
- **Decision runs at origin-request, not viewer-request.** Cache hits have nothing to decide. `edge/README.md`
- **Lab collection has no ALB and no CloudFront.** A CDN in front would erase the cache-state axis the grid exists to observe. `infra/README.md`
- **Load axis is 30/50/70 % CPU, not 30/65/90.** A single-process `next start` on a 2 vCPU Fargate task tops out at ~71 % (VU 512 → 66–71 %, VU 1024 → same RPS, VU 2048 → the metrics endpoint stops answering). 90 % is unreachable, so `load/profile.json` targets were redefined and `maxVus` is 512. `high` cells record the *measured* sustained CPU (63–69 %), and a "목표 미달" calibration warning is expected there. `load/profile.json`, `load/search.mjs`
- **`ServerCost` in the labels is partly unmeasured.** The `missRate` formula is replaced by observed render occurrence (background load deliberately avoids the measured routes, so `rps_r` is meaningless there), per-row `serverRenderCpuUs` is replaced by an N-rep mean because of timer quantization, and `C_serve`/`C_store` are **0 — not approximated, uninstrumented**. `training/README.md`

## Failures that pass silently

The expensive bugs in this repo do not throw. They produce a plausible number and a green
check. The full lists live in the sub-READMEs; these span more than one package:

- **Classifying headless Chrome as a bot.** Every worker request hard-pins to SSR and `check:policy` passes while comparing ssr against ssr. This actually happened on the first stage-4 run.
- **CDP throttling does not change Client Hints.** Unless workers inject `x-cell-device-tier`/`x-cell-effective-type`, the device and network features are constant across the whole lab dataset — the two axes the model exists to learn.
- **Feature-order drift between `policy/features.ts` and `training/config.py`.** Train-serve skew with no error; `surrogate.ts`'s `x[cur.feature] ?? 0` reads a missing feature as 0. `npm run check:tree` is the gate — run it before copying any tree into `policy/model/`.
- **A floating Promise for the server-state refresh.** Cancelled after the response returns, so the cache stays empty and every server-state feature is 0, forever, without an error. Use `event.waitUntil`.
- **Calibrating the load level on a short burst.** A fixed VU count pins *concurrency*, not CPU: throughput is `concurrency / (thinkTime + responseTime)`, and response time grows as the SUT saturates, so sustained CPU settles below what a 20-second window measures. Every load level in slice-b2 sat 12–16%p under its calibration. The number lands in `experiment.json`, `features.py` maps it onto every row of that level, and the load axis is then labelled with a CPU the server never had. `calibrateRemote` searches on bursts but records a **sustained** hold — the value the drift verifier compares against during measurement.
- **CloudFormation does not restore `desiredCount`.** A service scaled to 0 by hand or by the failure Lambda stays at 0 across redeploys whose template didn't change for it; the worker's first `/vus` call then fails and the whole SFN dies in a minute. `start-collection.sh` forces every service to 1 and waits — do not start an execution any other way.
- **High-load cells lose samples to "비콘 미도착".** Under `high` load, 10–30 % of reps time out before the beacon lands, so those cells finish with n=21–29 and run ~2× slower than the rest (the high shards are the tail of every collection). It is a Fargate-only effect (0/60 locally); the reason breakdown is in each cell summary and checkpoint. Check the per-load n distribution before training.

## Reproducibility requirements

These are research-grade constraints, stricter than normal engineering habit:

- Pin container images by `sha256` digest. `:latest` tags are disqualifying.
- Record Chrome, Playwright, Node, and Next.js versions in every experiment record — a browser update alone shifts performance characteristics.
- Record all seeds (training seed, condition-order randomization seed) in experiment metadata.
- Randomize condition order so infrastructure drift over the run doesn't load onto one mode systematically.
- Condition grids, scenarios, and policy versions live in version-controlled code, not in ad-hoc scripts.
- Split data by time *and* by route/session group. A session spanning train and validation leaks.

## Repository layout

Non-ASCII directory names — quote paths in shell commands.

- `00_Main/`, `01_연구 계획서/` — proposal submissions (PDF/DOCX)
- `02_참고 논문/` — reference papers on CSR/SSR performance
- `99_기타/` — past UGRP award reports, admin documents
- `03_Project/docs/` — `benchmark-app-design.md` (SUT), `project-overview-and-code-guide.md` (map for newcomers), `paper-outline.md` + `references.md` (thesis outline; chapters 6–7 wait on stage 6)
- `03_Project/apps/benchmark/` — the SUT (see its `README.md` for the internal structure and the traps)
- `03_Project/apps/benchmark/policy/` — the decision layer. Must not import `app/`, `components/`, or `node:*` — it is destined for Lambda@Edge, and `check:policy` enforces the boundary.
- `03_Project/load/` — background load. `profile.json` is read by both the k6 deployment script and the local Node generator; keeping one definition is what makes a calibrated VU count portable.
- `03_Project/infra/` — AWS CDK app: network, data, shards, orchestration, serving. `scripts/` is the collection runbook. `cdk.out/` is gitignored.
- `03_Project/edge/` — policy serving plane. A thin adapter over `policy/`, not a second copy of it. `dist/` and `src/config.generated.js` are generated.
- `03_Project/workers/` — Playwright measurement workers. `lib/grid.mjs` and `lib/shard.mjs` are the version-controlled experiment definition, not script parameters.
- `03_Project/workers/runs/` — local pilot data (gitignored). Cloud runs land in S3 (`experiment=/dt=/shard=/<cell>.jsonl`).
- `03_Project/training/` — Python training pipeline (stage 7). `ugrp_train/` is the package,
  `scripts/` the CLI entry points. `data/` and `out/` are gitignored (generated).

`.gitignore` excludes all PDF/DOCX/PPTX/HWP/XLSX and all of `99_기타/` — that directory holds invoices and receipts. The repo is private, but keep binaries and personal documents out of it regardless.
