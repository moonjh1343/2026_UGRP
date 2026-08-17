"""
λ 스윕 + 절제 실험 (논문 7.4·7.7).

train.py와 같은 적재·라벨·분할·학습 경로를 쓰되, 데이터는 한 번만 읽고 설정만 바꿔
반복한다. 절제의 평가는 **항상 기준 라벨**(z-정규화 QoE + λ=1·ServerCost)의 조건별
오라클에 대해 한다 — 절제는 학습 입력만 바꾸고, 채점 기준은 고정해야 비교가 된다.
λ 스윕만 예외로, 그 λ의 J에 대한 regret과 함께 선택 모드의 (QoE항, 서버비용) 평균을
남긴다 — 파레토는 후자로 그린다.

  python scripts/sweep.py --runs grid-v1 --out out/sweep
  python scripts/sweep.py --runs grid-v1 --out out/sweep --seeds 3 --only lambda,depth
"""
from __future__ import annotations

import argparse, json, sys, warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ugrp_train import io, labels, features, split, model, evaluate, distill  # noqa: E402
from ugrp_train.config import QOE_WEIGHTS, FEATURE_ORDER, MODES  # noqa: E402
from ugrp_train.labels import QOE_METRICS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]

FEATURE_GROUPS = {
    "device": ["deviceTier", "deviceMemory", "hardwareConcurrency", "prevLcpMs", "prevTbtMs", "saveData"],
    "network": ["effectiveTypeIdx", "rttMs", "downlinkMbps"],
    "load": ["cpuPct", "eventLoopP95Ms", "inflight", "cacheHitRate", "routeRps"],
    "route": ["nodeCount", "interactiveCount", "payloadKB", "fetchDepth", "fetchDelayMs",
              "personalizedRatio", "seoWeight", "bundleKB"],
}


def cond_table(labeled: pd.DataFrame, idx) -> pd.DataFrame:
    """조건×모드 단위 표 — 기준 J, QoE항, 서버비용의 반복 평균."""
    sub = labeled.loc[idx]
    return (sub.groupby([*evaluate.GROUP_KEYS, "mode"])[["J", "qoeTerm", "serverCostMs"]]
            .mean().reset_index())


def score(cond: pd.DataFrame, pred_col: str, j_col: str = "J") -> dict:
    """evaluate_policy + 선택 모드의 QoE항/서버비용 평균."""
    c = cond.copy()
    if j_col != "J":
        c["J"] = c[j_col]
    r = evaluate.evaluate_policy(c, pred_col)
    # 선택 모드의 원 지표 — 조건별 argmin(pred)
    chosen_idx = c.groupby(evaluate.GROUP_KEYS)[pred_col].idxmin()
    ch = c.loc[chosen_idx]
    return {
        "n": r["n"], "top1Rate": r["top1Rate"], "meanRegret": r["meanRegret"],
        "medianRegret": r["medianRegret"], "p95Regret": r["p95Regret"],
        "pairwiseAccuracy": r["pairwiseAccuracy"],
        "chosenQoeTerm": float(ch["qoeTerm"].mean()),
        "chosenServerCostMs": float(ch["serverCostMs"].mean()),
    }


def attach_pred(cond: pd.DataFrame, test_df: pd.DataFrame, pred: np.ndarray, name: str) -> pd.DataFrame:
    t = test_df[[*evaluate.GROUP_KEYS, "mode"]].copy()
    t[name] = pred
    p = t.groupby([*evaluate.GROUP_KEYS, "mode"])[name].mean().reset_index()
    return cond.merge(p, on=[*evaluate.GROUP_KEYS, "mode"], how="left")


def fmt(name: str, r: dict) -> str:
    return (f"  {name:<22} n={r['n']:4d} top1={r['top1Rate']*100:5.1f}% regret(평균)={r['meanRegret']:6.3f} "
            f"pairwise={r['pairwiseAccuracy']*100:5.1f}% QoE항={r['chosenQoeTerm']:+.3f} 서버ms={r['chosenServerCostMs']:.3f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*", default=None)
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--alpha", type=float, default=0.3)
    ap.add_argument("--boost-rounds", type=int, default=200)
    ap.add_argument("--lambdas", default="0,0.1,0.3,1,3,10")
    ap.add_argument("--depths", default="2,3,4,5,7")
    ap.add_argument("--only", default="lambda,ablation,depth")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "out" / "sweep"))
    args = ap.parse_args()
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    only = set(args.only.split(","))
    lambdas = [float(x) for x in args.lambdas.split(",")]
    depths = [int(x) for x in args.depths.split(",")]

    warnings.simplefilter("ignore")
    print("데이터 적재 중...")
    raw = io.load_runs(args.runs)
    routes = io.load_route_snapshot(io.DEFAULT_SNAPSHOT)
    print(f"  행 {len(raw)}")

    # 기준 라벨(λ=1)·피처·분할 — 모든 실험이 공유
    base = labels.compute_labels(raw, weights=QOE_WEIGHTS, lam=1.0)
    X = features.build_feature_frame(base, routes, calibration=None)
    X.index = base.index
    meta = base[["device", "network", "load", "routeType", "routeKey", "mode", "ts"]]
    train_idx, test_idx = split.time_and_group_split(base, group_col="routeKey")
    print(f"  학습 {len(train_idx)} / 검증 {len(test_idx)}")
    test_df = base.loc[test_idx]
    cond_base = cond_table(base, test_idx)

    def fit(Xtr, ytr):
        return model.train_ensemble(Xtr, ytr, meta.loc[train_idx], n_seeds=args.seeds,
                                    alpha=args.alpha, num_boost_round=args.boost_rounds)

    results: dict = {"config": vars(args), "nTrain": int(len(train_idx)), "nTest": int(len(test_idx))}

    # ── 기준선 (파레토 참고점) ────────────────────────────────────────────────
    print("\n[기준선 — 기준 라벨 λ=1]")
    results["baselines"] = {}
    for m in MODES:
        feas = cond_base.groupby(evaluate.GROUP_KEYS)["mode"].transform(lambda s, m=m: (s == m).any())
        sub = cond_base[feas].copy()
        if sub.empty:
            continue
        sub["p"] = np.where(sub["mode"] == m, -1e9, 1e9)
        r = score(sub, "p"); results["baselines"][f"fixed-{m}"] = r; print(fmt(f"fixed-{m}", r))
    orc = cond_base.copy(); orc["p"] = orc["J"]
    r = score(orc, "p"); results["baselines"]["oracle"] = r; print(fmt("oracle", r))

    # ── λ 스윕 ───────────────────────────────────────────────────────────────
    if "lambda" in only:
        print("\n[λ 스윕] 각 λ로 라벨·학습, 그 λ의 J로 채점 + 선택 모드의 QoE항/서버비용")
        results["lambda"] = {}
        for lam in lambdas:
            lab = labels.compute_labels(raw, weights=QOE_WEIGHTS, lam=lam)
            boosters = fit(X.loc[train_idx], lab.loc[train_idx, "J"].to_numpy())
            pred, _ = model.ensemble_predict(boosters, X.loc[test_idx])
            cond = cond_table(lab, test_idx)
            cond = attach_pred(cond, test_df, pred, "pred")
            r_own = score(cond, "pred")                          # 그 λ의 J 기준
            cond_b = attach_pred(cond_base, test_df, pred, "pred")
            r_base = score(cond_b, "pred")                       # 기준 λ=1의 J 기준
            orc = cond.copy(); orc["p"] = orc["J"]; r_orc = score(orc, "p")
            results["lambda"][str(lam)] = {"ownLabel": r_own, "baseLabel": r_base, "oracleOwn": r_orc}
            print(f" λ={lam}"); print(fmt("surrogate(own J)", r_own)); print(fmt("surrogate(base J)", r_base)); print(fmt("oracle(own J)", r_orc))
            json.dump(results, open(out_dir / "sweep.json", "w"), indent=2, default=str)

    # ── 절제 ─────────────────────────────────────────────────────────────────
    if "ablation" in only:
        print("\n[절제] 학습 입력만 바꾸고 기준 라벨(λ=1)로 채점")
        results["ablation"] = {}
        y_base = base.loc[train_idx, "J"].to_numpy()

        def run(name, Xtr, ytr, Xte):
            boosters = fit(Xtr, ytr)
            pred, _ = model.ensemble_predict(boosters, Xte)
            cond = attach_pred(cond_base, test_df, pred, "pred")
            r = score(cond, "pred"); results["ablation"][name] = r; print(fmt(name, r))
            json.dump(results, open(out_dir / "sweep.json", "w"), indent=2, default=str)

        run("full", X.loc[train_idx], y_base, X.loc[test_idx])

        # z-정규화 없음: 라우트별 정규화 대신 전역 z(지표 스케일만 맞춤) — "무거운 페이지=나쁨" 신호가 남는다
        nz = base.copy()
        for m in QOE_METRICS:
            col = nz[m].astype(float)
            nz[f"z_{m}"] = ((col - col.mean()) / col.std()).fillna(0.0)
        present = nz[QOE_METRICS].notna(); w = pd.Series(QOE_WEIGHTS)
        qoe = sum(nz[f"z_{m}"] * present[m] * w[m] for m in QOE_METRICS) / sum(present[m] * w[m] for m in QOE_METRICS)
        y_nz = (qoe.fillna(0.0) + 1.0 * nz["serverCostMs"]).loc[train_idx].to_numpy()
        run("no-route-zscore", X.loc[train_idx], y_nz, X.loc[test_idx])

        # 피처군 제거: 해당 열을 상수 0으로 (스키마 유지)
        for g, cols in FEATURE_GROUPS.items():
            Xa = X.copy(); Xa[[c for c in cols if c in Xa.columns]] = 0.0
            run(f"drop-{g}", Xa.loc[train_idx], y_base, Xa.loc[test_idx])

        # 서버 상태 staleness: 행의 실측 cpuPct 대신 부하 수준 평균(≈30초 캐시가 줄 값)
        Xs = X.copy()
        lvl_mean = base.groupby("load")["serverCpuPct"].mean() if "serverCpuPct" in base.columns else None
        if lvl_mean is not None:
            Xs["cpuPct"] = base["load"].map(lvl_mean).fillna(0.0).to_numpy()
            run("stale-cpu(level-mean)", Xs.loc[train_idx], y_base, Xs.loc[test_idx])
        # 극단: 서버 상태 완전 부재
        Xs2 = X.copy(); Xs2[["cpuPct", "eventLoopP95Ms"]] = 0.0
        run("no-server-state", Xs2.loc[train_idx], y_base, Xs2.loc[test_idx])

        # alpha(pairwise 항) 절제
        for a in (0.0, 0.6):
            boosters = model.train_ensemble(X.loc[train_idx], y_base, meta.loc[train_idx], n_seeds=args.seeds,
                                            alpha=a, num_boost_round=args.boost_rounds)
            pred, _ = model.ensemble_predict(boosters, X.loc[test_idx])
            cond = attach_pred(cond_base, test_df, pred, "pred")
            r = score(cond, "pred"); results["ablation"][f"alpha={a}"] = r; print(fmt(f"alpha={a}", r))

    # ── 트리 깊이 ────────────────────────────────────────────────────────────
    if "depth" in only:
        print("\n[증류 깊이] 기준 앙상블(λ=1) → 깊이별 트리")
        results["depth"] = {}
        boosters = fit(X.loc[train_idx], base.loc[train_idx, "J"].to_numpy())
        full_pred, _ = model.ensemble_predict(boosters, X)
        ens_test, _ = model.ensemble_predict(boosters, X.loc[test_idx])
        cond = attach_pred(cond_base, test_df, ens_test, "pred")
        r = score(cond, "pred"); results["depth"]["ensemble"] = r; print(fmt("ensemble", r))
        for d in depths:
            tree = distill.distill_tree(X, full_pred, max_depth=d)
            tp = tree.predict(X.loc[test_idx][FEATURE_ORDER])
            r2 = 1 - ((tp - ens_test) ** 2).sum() / ((ens_test - ens_test.mean()) ** 2).sum()
            cond = attach_pred(cond_base, test_df, tp, "pred")
            r = score(cond, "pred"); r["r2VsEnsemble"] = float(r2); r["leaves"] = int(tree.get_n_leaves())
            results["depth"][str(d)] = r; print(fmt(f"depth={d} (R²={r2:.3f}, 잎 {tree.get_n_leaves()})", r))
        json.dump(results, open(out_dir / "sweep.json", "w"), indent=2, default=str)

    json.dump(results, open(out_dir / "sweep.json", "w"), indent=2, default=str)
    print(f"\n→ {out_dir/'sweep.json'}")


if __name__ == "__main__":
    main()
