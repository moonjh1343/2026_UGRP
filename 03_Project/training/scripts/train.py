"""
학습 파이프라인 진입점 (제안서 §5.4, §4).

  적재 → 라벨(J) → 피처(toVector 스키마) → 시간+그룹 분할 → LightGBM(MSE+pairwise) 학습
  → 기준선과 비교 평가 → (선택) 깊이 5 트리 증류

수집이 끝나지 않아도 지금 있는 데이터로 돌아간다 — 표본이 적으면 경고만 내고
계속한다. 파이프라인 자체가 죽어 있는지 아닌지를 데이터가 다 모일 때까지
기다렸다가 확인할 이유가 없다.

사용:
  python scripts/train.py                          # runs/ 아래 전부
  python scripts/train.py --runs pilot-low-idle     # 특정 실험만
  python scripts/train.py --distill --out model     # 증류 트리까지 산출
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

# Windows 콘솔 기본 코드페이지(cp949)는 em dash 같은 문자를 표현하지 못해
# print()가 UnicodeEncodeError로 죽는다. 표준 출력을 UTF-8로 강제한다.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from ugrp_train import evaluate, features, io, labels, model, split
from ugrp_train.config import FEATURE_ORDER, QOE_WEIGHTS

REPO_ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*", default=None, help="특정 실험 이름만 (기본: runs/ 전부)")
    ap.add_argument("--snapshot", default=None, help="route_snapshot.json 경로")
    ap.add_argument("--seeds", type=int, default=5, help="앙상블 시드 수 (§4.3)")
    ap.add_argument("--alpha", type=float, default=0.3, help="pairwise 항 가중치 (§4.2)")
    ap.add_argument("--epsilon", type=float, default=0.1, help="pairwise 힌지 마진")
    ap.add_argument("--boost-rounds", type=int, default=200)
    ap.add_argument("--lambda", dest="lam", type=float, default=1.0, help="ServerCost 가중치")
    ap.add_argument("--distill", action="store_true", help="트리 증류 (--distill-depth 참고)")
    ap.add_argument("--distill-depth", type=int, default=5,
                    help="증류 트리 깊이. λ<1은 문맥 상호작용 때문에 5로 부족하다 — reports/grid-v1.depth-*.json")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "out"))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("데이터 적재 중...")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        raw = io.load_runs(args.runs)
        for w in caught:
            print(f"  주의: {w.message}")
    print(f"  측정 행 {len(raw)}개, 실험 {raw['experiment'].nunique()}개")

    snapshot_path = Path(args.snapshot) if args.snapshot else io.DEFAULT_SNAPSHOT
    routes = io.load_route_snapshot(snapshot_path)

    print("라벨 계산 중 (J = Σw·z_r(QoE) + λ·ServerCost)...")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        labeled = labels.compute_labels(raw, weights=QOE_WEIGHTS, lam=args.lam)
        for w in caught:
            print(f"  주의: {w.message}")

    print("피처 행렬 구성 중...")
    # 실험마다 캘리브레이션이 다를 수 있으므로 실험 단위로 붙인다.
    exp_calibration = {}
    for exp_name in labeled["experiment"].unique():
        run_dir = REPO_ROOT / "03_Project" / "workers" / "runs" / exp_name
        cal = None
        meta_path = run_dir / "experiment.json"
        if meta_path.exists():
            cal = json.loads(meta_path.read_text(encoding="utf-8")).get("calibration")
        # 원격 수집은 experiment.json의 calibration이 의도적으로 null이다(다른 기계의
        # 숫자를 남기지 않는다 — run.mjs 주석). 실행 시점 값은 calibration.observed.json
        # (로컬 실행이 남기거나, DynamoDB의 #calibration#<shard>에서 받아온 것)에 있다.
        observed_path = run_dir / "calibration.observed.json"
        if observed_path.exists():
            observed = json.loads(observed_path.read_text(encoding="utf-8"))
            cal = {**(cal or {}), **(observed.get("levels") or {})}
        exp_calibration[exp_name] = cal

    frames = []
    for exp_name, sub in labeled.groupby("experiment"):
        X_sub = features.build_feature_frame(sub, routes, calibration=exp_calibration.get(exp_name))
        X_sub.index = sub.index
        frames.append(X_sub)

    X = pd.concat(frames).sort_index()
    meta = labeled[["device", "network", "load", "routeType", "routeKey", "mode", "ts"]]

    n_routes = labeled["routeKey"].nunique()
    print(f"  라우트 {n_routes}종, 조건 {len(labeled.groupby(evaluate.GROUP_KEYS))}개")
    if n_routes < 5:
        print("  주의: 라우트 종류가 5 미만이다 — 그룹 분할·GroupKFold가 사실상 무의미한 규모다.")

    print("분할 중 (시간 + 라우트 그룹)...")
    train_idx, test_idx = split.time_and_group_split(labeled, group_col="routeKey")
    print(f"  학습 {len(train_idx)}행 / 검증 {len(test_idx)}행")

    print(f"학습 중 (LightGBM × {args.seeds}시드, alpha={args.alpha})...")
    y_train = labeled.loc[train_idx, "J"].to_numpy()
    boosters = model.train_ensemble(
        X.loc[train_idx], y_train, meta.loc[train_idx],
        n_seeds=args.seeds, alpha=args.alpha, epsilon=args.epsilon, num_boost_round=args.boost_rounds,
    )

    if len(test_idx) == 0:
        print("  검증 집합이 비었다 — 데이터가 너무 적다. 평가를 건너뛴다.")
    else:
        print("\n평가 (검증 집합, 조건 단위)...")
        test_df = labeled.loc[test_idx].copy()
        test_X = X.loc[test_idx]
        pred_mean, _ = model.ensemble_predict(boosters, test_X)
        test_df["predJ"] = pred_mean
        # rule-based 기준선의 busy 분기(cpuPct > 80)가 쓸 조건별 서버 CPU
        test_df["cpuPct"] = test_X["cpuPct"].to_numpy()

        cond = evaluate.aggregate_by_condition(test_df)
        pred_cond = test_df.groupby([*evaluate.GROUP_KEYS, "mode"])["predJ"].mean().reset_index()
        cond = cond.merge(pred_cond, on=[*evaluate.GROUP_KEYS, "mode"])

        surrogate_result = evaluate.evaluate_policy(cond, "predJ")

        # 기준선: 모드 고정 5종
        print("\n기준선 대비:")
        from ugrp_train.config import MODES

        for fixed_mode in MODES:
            # **실행 불가능 조건은 제외한다.** M(r)에 이 모드가 없는 조건에서
            # ±1e9 인코딩은 argmin을 정렬상 첫 후보(대개 csr)로 흘려보낸다 —
            # "infeasible 폴백을 조용히 하는 정책은 기준선으로 못 쓴다"(CLAUDE.md)는
            # 원칙 그대로다. fixed-ssg의 대시보드·폼 성적은 사실 fixed-csr 성적이었다.
            feasible = cond.groupby(evaluate.GROUP_KEYS)["mode"].transform(
                lambda s, m=fixed_mode: (s == m).any()
            )
            sub = cond[feasible].copy()
            n_excluded = cond.loc[~feasible].groupby(evaluate.GROUP_KEYS).ngroups
            if len(sub) == 0:
                print(f"  fixed-{fixed_mode:8s}  실행 가능한 조건 없음 — 제외")
                continue
            sub[f"pred_{fixed_mode}"] = np.where(sub["mode"] == fixed_mode, -1e9, 1e9)
            r = evaluate.evaluate_policy(sub, f"pred_{fixed_mode}")
            suffix = f"  (실행 불가 조건 {n_excluded}개 제외)" if n_excluded else ""
            print(evaluate.format_report(f"fixed-{fixed_mode}", r) + suffix)

        # 기준선: policy/policies.ts의 rule-based를 그대로 옮긴 규칙.
        # 조건별 후보 모드 목록을 모아 한 번에 벡터화(merge)로 붙인다 —
        # 행 단위 DataFrame 비교(.all(axis=1))는 pandas 버전에 따라 정렬 오류가 난다.
        group_modes = cond.groupby(evaluate.GROUP_KEYS)["mode"].apply(list).reset_index(name="candidates")
        # busy 분기(cpuPct > 80)의 입력 — 조건별 실측 서버 CPU 평균
        cond_cpu = test_df.groupby(evaluate.GROUP_KEYS)["cpuPct"].mean().reset_index(name="condCpuPct")
        group_modes = group_modes.merge(cond_cpu, on=evaluate.GROUP_KEYS, how="left")
        group_modes["chosenMode"] = model.rule_based_predict_mode(
            group_modes,
            group_modes["candidates"].tolist(),
            cpu_pct=group_modes["condCpuPct"].fillna(0.0).to_numpy(),
        )
        cond = cond.merge(group_modes[[*evaluate.GROUP_KEYS, "chosenMode"]], on=evaluate.GROUP_KEYS, how="left")
        cond["pred_rule-based"] = np.where(cond["mode"] == cond["chosenMode"], -1e9, 1e9)
        r = evaluate.evaluate_policy(cond, "pred_rule-based")
        print(evaluate.format_report("rule-based", r))

        print(evaluate.format_report("surrogate", surrogate_result))

        report_path = out_dir / "eval_report.json"
        report_path.write_text(
            json.dumps(
                {k: v for k, v in surrogate_result.items() if k != "detail"},
                indent=2,
                default=str,
            ),
            encoding="utf-8",
        )
        print(f"\n평가 리포트 → {report_path}")

    if args.distill:
        print(f"\n깊이 {args.distill_depth} 트리 증류 중...")
        from ugrp_train import distill

        full_pred, _ = model.ensemble_predict(boosters, X)
        tree = distill.distill_tree(X, full_pred, max_depth=args.distill_depth)

        # 경고 기준은 행 수가 아니라 **셀 커버리지**다. slice-b2는 35,988행이지만
        # 그리드의 ~11%다 — 행 수 기준(≥5000)은 "반복이 많은 좁은 슬라이스"를
        # 전체 데이터처럼 통과시킨다.
        FULL_GRID_CELLS = 10_400
        n_cells = int(labeled["cellId"].nunique()) if "cellId" in labeled.columns else 0
        coverage = n_cells / FULL_GRID_CELLS
        warning = None if coverage >= 0.5 else (
            f"셀 커버리지 {n_cells}/{FULL_GRID_CELLS} ({coverage:.1%}) — 행 수({len(labeled)})가 "
            "커 보여도 그리드의 일부다. 이 트리를 실배포 판단에 쓰지 말 것."
        )

        tree_json = distill.export_tree_json(
            tree,
            version=f"trained-{pd.Timestamp.now(tz='UTC').strftime('%Y%m%dT%H%M%SZ')}",
            distilled_from={"nSeeds": args.seeds, "alpha": args.alpha, "boostRounds": args.boost_rounds},
            trained_on={
                "nRows": len(labeled),
                # 부스터가 실제로 본 행 수. nRows(전체)만 적으면 검증 행까지 학습한
                # 것처럼 읽힌다 — 교사 예측(full_pred)은 전체에 대해 만들지만
                # 부스터 학습은 train 분할만 썼다.
                "nTrainRows": int(len(train_idx)),
                "nCells": n_cells,
                "experiments": sorted(labeled["experiment"].unique().tolist()),
            },
            warning=warning,
        )
        tree_path = out_dir / "tree.json"
        tree_path.write_text(json.dumps(tree_json, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  → {tree_path}")
        print(f"  사용된 피처: {tree_json['features']}")

        if len(test_idx) > 0:
            # ── 배포 산출물 검증 — 증류 트리 **자체**를 채점한다 ──────────────
            # 앙상블만 평가하고 트리를 안 보면 depth-5 절단이 argmin을 뒤집어도
            # 모든 게이트가 초록인 채 policy/model/로 들어간다(check:tree는
            # 스키마만 본다). 충실도(대 앙상블)와 조건 단위 성적을 함께 남긴다.
            tree_pred_test = tree.predict(test_X[FEATURE_ORDER])
            ens_test = test_df["predJ"].to_numpy()
            resid = tree_pred_test - ens_test
            var = float(np.var(ens_test)) or 1.0
            fidelity_r2 = 1.0 - float(np.mean(resid**2)) / var

            test_df["treeJ"] = tree_pred_test
            tree_cond = test_df.groupby([*evaluate.GROUP_KEYS, "mode"])["treeJ"].mean().reset_index()
            cond_tree = cond.merge(tree_cond, on=[*evaluate.GROUP_KEYS, "mode"])
            tree_result = evaluate.evaluate_policy(cond_tree, "treeJ")

            print(f"  증류 충실도 R² (대 앙상블, 검증 집합) = {fidelity_r2:.3f}")
            print(evaluate.format_report("distilled-tree", tree_result))
            distill_report = {
                "fidelityR2VsEnsemble": fidelity_r2,
                **{k: v for k, v in tree_result.items() if k != "detail"},
            }
            (out_dir / "distill_report.json").write_text(
                json.dumps(distill_report, indent=2, default=str), encoding="utf-8"
            )
            print(f"  증류 평가 → {out_dir / 'distill_report.json'}")


if __name__ == "__main__":
    main()
