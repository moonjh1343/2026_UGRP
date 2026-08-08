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
    ap.add_argument("--distill", action="store_true", help="깊이 5 트리까지 증류")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "out"))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("데이터 적재 중...")
    raw = io.load_runs(args.runs)
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
        meta_path = REPO_ROOT / "03_Project" / "workers" / "runs" / exp_name / "experiment.json"
        if meta_path.exists():
            exp_calibration[exp_name] = json.loads(meta_path.read_text(encoding="utf-8")).get("calibration")

    frames = []
    for exp_name, sub in labeled.groupby("experiment"):
        X_sub = features.build_feature_frame(sub, routes, calibration=exp_calibration.get(exp_name))
        X_sub.index = sub.index
        frames.append(X_sub)
    import pandas as pd

    X = pd.concat(frames).sort_index()
    meta = labeled[["device", "network", "load", "routeType", "routeKey", "mode", "ts"]]

    n_routes = labeled["routeKey"].nunique()
    print(f"  라우트 {n_routes}종, 조건 {len(labeled.groupby(evaluate.GROUP_KEYS))}개")
    if n_routes < 5:
        print("  주의: 라우트 종류가 5 미만이다 — 그룹 분할·GroupKFold가 사실상 무의미한 규모다.")

    print("분할 중 (시간 + 라우트 그룹)...")
    train_idx, test_idx = split.time_and_group_split(labeled, group_col="routeKey")
    print(f"  학습 {len(train_idx)}행 / 검증 {len(test_idx)}행")

    if len(test_idx) == 0:
        print("  검증 집합이 비었다 — 데이터가 너무 적다. 평가를 건너뛴다.")
        y_train = labeled.loc[train_idx, "J"].to_numpy()
        boosters = model.train_ensemble(
            X.loc[train_idx], y_train, meta.loc[train_idx],
            n_seeds=args.seeds, alpha=args.alpha, epsilon=args.epsilon, num_boost_round=args.boost_rounds,
        )
    else:
        print(f"학습 중 (LightGBM × {args.seeds}시드, alpha={args.alpha})...")
        y_train = labeled.loc[train_idx, "J"].to_numpy()
        boosters = model.train_ensemble(
            X.loc[train_idx], y_train, meta.loc[train_idx],
            n_seeds=args.seeds, alpha=args.alpha, epsilon=args.epsilon, num_boost_round=args.boost_rounds,
        )

        print("\n평가 (검증 집합, 조건 단위)...")
        test_df = labeled.loc[test_idx].copy()
        test_X = X.loc[test_idx]
        pred_mean, pred_std = model.ensemble_predict(boosters, test_X)
        test_df["predJ"] = pred_mean
        test_df["predJStd"] = pred_std

        cond = evaluate.aggregate_by_condition(test_df)
        pred_cond = test_df.groupby([*evaluate.GROUP_KEYS, "mode"])["predJ"].mean().reset_index()
        cond = cond.merge(pred_cond, on=[*evaluate.GROUP_KEYS, "mode"])

        surrogate_result = evaluate.evaluate_policy(cond, "predJ")

        # 기준선: 모드 고정 5종
        print("\n기준선 대비:")
        from ugrp_train.config import MODES

        for fixed_mode in MODES:
            cond[f"pred_{fixed_mode}"] = np.where(cond["mode"] == fixed_mode, -1e9, 1e9)
            r = evaluate.evaluate_policy(cond, f"pred_{fixed_mode}")
            print(evaluate.format_report(f"fixed-{fixed_mode}", r))

        # 기준선: policy/policies.ts의 rule-based를 그대로 옮긴 규칙.
        # 조건별 후보 모드 목록을 모아 한 번에 벡터화(merge)로 붙인다 —
        # 행 단위 DataFrame 비교(.all(axis=1))는 pandas 버전에 따라 정렬 오류가 난다.
        group_modes = cond.groupby(evaluate.GROUP_KEYS)["mode"].apply(list).reset_index(name="candidates")
        group_modes["chosenMode"] = model.rule_based_predict_mode(
            group_modes, group_modes["candidates"].tolist()
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
        print("\n깊이 5 트리 증류 중...")
        from ugrp_train import distill

        full_pred, _ = model.ensemble_predict(boosters, X)
        tree = distill.distill_tree(X, full_pred)
        tree_json = distill.export_tree_json(
            tree,
            version=f"trained-{pd.Timestamp.now(tz='UTC').strftime('%Y%m%dT%H%M%SZ')}",
            distilled_from={"nSeeds": args.seeds, "alpha": args.alpha, "boostRounds": args.boost_rounds},
            trained_on={"nRows": len(labeled), "experiments": sorted(labeled["experiment"].unique().tolist())},
            warning=None if len(labeled) >= 5000 else (
                f"학습 표본 {len(labeled)}행 — 6단계 전체 그리드(31만행)에 비해 매우 적다. "
                "이 트리를 실배포 판단에 쓰지 말 것."
            ),
        )
        tree_path = out_dir / "tree.json"
        tree_path.write_text(json.dumps(tree_json, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  → {tree_path}")
        print(f"  사용된 피처: {tree_json['features']}")


if __name__ == "__main__":
    main()
