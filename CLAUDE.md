# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

Research repository with one implemented component: the SUT at `03_Project/apps/benchmark/` (Next.js). Everything else is planning material, most of it untracked (binaries are gitignored — see the layout section).

All commands run from `03_Project/apps/benchmark/`:

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

Stage 5 lives outside the app, in its own packages (`npm install` in each):

```bash
cd 03_Project/load    && node calibrate.mjs            # 목표 CPU → VU 이진 탐색
cd 03_Project/workers && node verify-variance.mjs      # 5단계 합격 기준
cd 03_Project/workers && node run.mjs --name pilot     # factorial 수집 (재개 가능)
```

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
```

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
npm run synth                      # no credentials needed
npx cdk synth -c ugrp:shardCount=40
```

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
- **Full-factorial lab collection to sidestep the counterfactual problem.** Lab conditions are reproducible, so every mode is measured under the same condition vector — a request is not limited to one observed treatment. Grid: device tier (4) × network (5) × route (25) × server load (4) × mode (5) = 10,000 cells, 30 reps each. Field randomization (5–10% of traffic, propensity logged) supplies unbiased data for off-policy evaluation.
- **Background server load must be exogenous.** The render mode itself changes server load, which is also a feature. Load is pinned by a k6 generator with autoscaling disabled and `desiredCount` fixed; a single measurement request rides on top.
- **In-process edge inference only.** A depth-5 tree distilled from the LightGBM ensemble is evaluated inside Lambda@Edge (~50KB JSON). A SageMaker endpoint in the request path would add tens of ms and cancel out the improvement it is measuring. Target overhead: TTFB increase < 2 ms.
- **Server-state features are intentionally stale (~30s).** Load doesn't swing per-second, and a DynamoDB round-trip per request costs more than the freshness is worth.
- **ML never decides SEO or correctness.** Crawler UAs and payment/auth routes are hard-pinned to SSR. A circuit breaker reverts all traffic to the default mode (Streaming SSR) on hydration-error or 5xx spikes.

## Architecture to be built

Five planes, all defined in AWS CDK (TypeScript):

1. **SUT** — Next.js App Router on ECS Fargate behind ALB + CloudFront, implementing all five render modes in one codebase. Task cpu/memory are experiment variables. ElastiCache holds mode-keyed caches; DynamoDB holds session profiles and bandit state.
2. **Client measurement** — AWS Batch/Fargate Playwright workers driving CDP (`Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions`) for ~95% of cells, real multi-region workers for true RTT (origin pinned to `ap-northeast-2`), EC2 + `tc`/netem where kernel-level control is needed, and Device Farm for a ~5% real-device calibration subset.
3. **Load injection** — k6 on Fargate Spot, on a separate subnet/security group from measurement workers. VU count is binary-searched to hit target CPU (30/65/90%) and then frozen into the cell definition.
4. **Data plane** — `web-vitals/attribution` in the worker → `sendBeacon` → Kinesis Firehose → S3 Parquet (partitioned by date and experiment id) → Glue/Athena.
5. **Training/serving** — SageMaker (Processing → Training → HPO → Model Registry) → distilled tree → AppConfig → Lambda@Edge.

Orchestration is Step Functions Distributed Map over the cell grid, with per-cell checkpointing in DynamoDB so a run can be stopped and resumed.

**The correlation-ID join is the integrity-critical path.** The render decision happens at the edge and the measurement happens in the browser; if those two records can't be joined, the dataset is worthless. Treat any change touching it accordingly.

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
- `03_Project/docs/` — design documents
- `03_Project/apps/benchmark/` — the SUT (see its `README.md` for the internal structure and the traps)
- `03_Project/apps/benchmark/policy/` — the decision layer. Must not import `app/`, `components/`, or `node:*` — it is destined for Lambda@Edge, and `check:policy` enforces the boundary.
- `03_Project/load/` — background load. `profile.json` is read by both the k6 deployment script and the local Node generator; keeping one definition is what makes a calibrated VU count portable.
- `03_Project/infra/` — AWS CDK app: network, data, shards, orchestration, serving. `cdk.out/` is gitignored.
- `03_Project/edge/` — policy serving plane. A thin adapter over `policy/`, not a second copy of it. `dist/` and `src/config.generated.js` are generated.
- `03_Project/workers/` — Playwright measurement workers. `lib/grid.mjs` and `lib/shard.mjs` are the version-controlled experiment definition, not script parameters.
- `03_Project/workers/runs/` — collected data (gitignored).
- `03_Project/training/` — Python training pipeline (stage 7). `ugrp_train/` is the package,
  `scripts/` the CLI entry points. `data/` and `out/` are gitignored (generated).

`.gitignore` excludes all PDF/DOCX/PPTX/HWP/XLSX and all of `99_기타/` — that directory holds invoices and receipts. The repo is private, but keep binaries and personal documents out of it regardless.
