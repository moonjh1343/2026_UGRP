# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This is a **research repository, not yet a codebase**. `03_Project/` (the primary working directory) is empty; only `README.md` is tracked in git. Everything else is untracked planning material. There are no build, lint, or test commands yet — when the first code lands, add them to this file.

Working language is Korean. Documents, comments, and discussion are in Korean; keep new prose in Korean unless asked otherwise.

## What the project is

**Context-adaptive rendering mode selection.** Web frameworks fix the rendering mode (CSR/SSR/SSG/ISR/Streaming SSR/Islands) per route at build time. This research treats the optimal mode as a *function of runtime environment* — client device tier, network quality, and instantaneous server load — and learns a policy that picks the mode per request/session.

Two planning documents define the system; read them before doing design work:

- `adaptive-rendering-research-proposal.md` — the full spec (32KB). Formalization, ML design, AWS infrastructure, evaluation. **This is the authoritative document.**
- `adaptive-rendering-research-plan-concise.md` — an earlier, narrower summary (SSR vs. CSR only, generic testbed). Superseded by the proposal where the two disagree.
- `PLMS.txt` — the original, abandoned project idea (a PLMS/POVIS clone). Historical only; ignore for current work.

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
- `03_Project/` — implementation target, currently empty

Nothing but `README.md` is tracked. Before the first substantive commit, add a `.gitignore` (PDFs, DOCX, HWP, PPTX, and `99_기타/제출 문서/` contain invoices/receipts) and decide deliberately which documents belong in version control.
