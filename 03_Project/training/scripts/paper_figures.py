"""
논문 §7.3(RQ1)·부록 E의 crosstab과 그림 7-1(최적 모드 히트맵)·7-2(파레토 곡선) 생성.

train.py와 같은 적재·라벨 경로를 쓴다. 그림 7-2는 데이터를 다시 읽지 않고
reports/grid-v1.sweep.json(sweep.py 출력)에서 그린다 — 본문 표 7-4와 같은 근거를
쓰는 것이 숫자·그림 불일치를 막는다. matplotlib은 requirements.txt에 없다(학습에
불필요) — 이 스크립트를 돌릴 때만 설치한다.

  python scripts/paper_figures.py --runs grid-v1
  → reports/grid-v1.rq1-crosstab.json, ../docs/figures/fig7-1-*.svg, fig7-2-pareto.svg
"""
from __future__ import annotations

import argparse, json, sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ugrp_train import io, labels, evaluate  # noqa: E402

TRAINING = Path(__file__).resolve().parents[1]
DOCS_FIG = TRAINING.parents[0] / "docs" / "figures"

AXES = {"device": ["flagship", "mid", "low", "very-low"],
        "network": ["5g", "lte", "3g-fast", "3g-slow", "offline-first"],
        "load": ["idle", "low", "mid", "high"]}
MODES = ["csr", "ssr", "stream", "ssg", "islands"]
MODE_COLOR = {"csr": "#d62728", "ssr": "#1f77b4", "stream": "#9467bd",
              "ssg": "#2ca02c", "islands": "#ff7f0e"}


def oracle_by_condition(labeled: pd.DataFrame) -> pd.DataFrame:
    """조건(라우트×디바이스×네트워크×부하)당 관측 최적 모드 한 행."""
    cond = evaluate.aggregate_by_condition(labeled)
    idx = cond.groupby(evaluate.GROUP_KEYS)["J"].idxmin()
    return cond.loc[idx].rename(columns={"mode": "oracleMode"})


def crosstabs(oracle: pd.DataFrame) -> dict:
    out = {"overallSharePct": (oracle["oracleMode"].value_counts(normalize=True) * 100)
           .round(1).to_dict()}
    for axis, levels in AXES.items():
        ct = pd.crosstab([oracle["routeType"], oracle[axis]], oracle["oracleMode"],
                         normalize="index") * 100
        out[axis] = {f"{rt}|{lv}": {m: round(ct.loc[(rt, lv)].get(m, 0.0), 1) for m in MODES}
                     for rt, lv in ct.index if lv in levels}
    return out


def margins(labeled_l03: pd.DataFrame) -> dict:
    """top-1·top-2의 J 마진 분포 (λ=0.3) — §3.4 τ 논거."""
    cond = evaluate.aggregate_by_condition(labeled_l03)
    m = (cond.sort_values("J").groupby(evaluate.GROUP_KEYS)["J"]
         .apply(lambda s: s.iloc[1] - s.iloc[0] if len(s) > 1 else np.nan).dropna())
    return {"n": int(m.size), "median": round(float(m.median()), 3),
            "p25": round(float(m.quantile(0.25)), 3),
            "shareBelow0.1Pct": round(float((m < 0.1).mean() * 100), 1)}


def qoe_medians(df: pd.DataFrame) -> dict:
    """본문 §7.3이 인용하는 원지표 중앙값 예시."""
    def med(rt, metric, by):
        sub = df[df["routeType"] == rt]
        return {f"{mo}|{lv}": round(float(v), 0) for (mo, lv), v in
                sub.groupby(["mode", by])[metric].median().items()}
    return {"content_LCP_by_network": med("content", "LCP", "network"),
            "list_TBT_by_device": med("list", "TBT", "device"),
            "content_TTFB_by_load": med("content", "TTFB", "load")}


def fig_heatmap(oracle: pd.DataFrame, path: Path) -> None:
    import matplotlib.pyplot as plt
    route_types = sorted(oracle["routeType"].unique())
    fig, axs = plt.subplots(1, 3, figsize=(13, 3.6),
                            gridspec_kw={"width_ratios": [len(v) for v in AXES.values()]})
    for ax, (axis, levels) in zip(axs, AXES.items()):
        ct = pd.crosstab([oracle["routeType"], oracle[axis]], oracle["oracleMode"],
                         normalize="index")
        for yi, rt in enumerate(route_types):
            for xi, lv in enumerate(levels):
                row = ct.loc[(rt, lv)]
                mode, share = row.idxmax(), row.max()
                ax.add_patch(plt.Rectangle((xi, yi), 1, 1, color=MODE_COLOR[mode],
                                           alpha=0.25 + 0.75 * share))
                ax.text(xi + 0.5, yi + 0.5, f"{mode}\n{share * 100:.0f}%",
                        ha="center", va="center", fontsize=7)
        ax.set_xlim(0, len(levels)); ax.set_ylim(len(route_types), 0)
        ax.set_xticks([i + 0.5 for i in range(len(levels))])
        ax.set_xticklabels(levels, rotation=30, ha="right", fontsize=7)
        ax.set_yticks([i + 0.5 for i in range(len(route_types))])
        ax.set_yticklabels(route_types if ax is axs[0] else [], fontsize=8)
        ax.set_title(axis, fontsize=10)
    fig.suptitle("Most-frequent oracle mode per route type × condition level (λ=0, share of conditions)",
                 fontsize=10)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def fig_pareto(sweep_path: Path, path: Path) -> None:
    import matplotlib.pyplot as plt
    lam = json.loads(sweep_path.read_text(encoding="utf-8"))["lambda"]
    lams = sorted(lam, key=float)
    pol = [(lam[k]["ownLabel"]["chosenServerCostMs"], lam[k]["ownLabel"]["chosenQoeTerm"]) for k in lams]
    ora = [(lam[k]["oracleOwn"]["chosenServerCostMs"], lam[k]["oracleOwn"]["chosenQoeTerm"]) for k in lams]
    fig, ax = plt.subplots(figsize=(5.2, 3.8))
    ax.plot(*zip(*pol), "o-", label="policy (ensemble)", color="#1f77b4")
    ax.plot(*zip(*ora), "s--", label="oracle", color="#7f7f7f", alpha=0.7)
    for k, (x, y) in zip(lams, pol):
        ax.annotate(f"λ={float(k):g}", (x, y), textcoords="offset points",
                    xytext=(6, -4 if float(k) < 0.3 else 8), fontsize=7)
    knee = pol[lams.index("0.3")]
    ax.plot(*knee, "o", ms=11, mfc="none", mec="#d62728", mew=1.5)
    ax.set_xlabel("chosen mean server render cost (ms)")
    ax.set_ylabel("chosen mean QoE term (z, lower = better)")
    ax.legend(fontsize=8); ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*", default=["grid-v1"])
    args = ap.parse_args()

    DOCS_FIG.mkdir(exist_ok=True)
    df = io.load_runs(args.runs)
    oracle = oracle_by_condition(labels.compute_labels(df, lam=0.0))

    report = {"runs": args.runs, "nConditions": int(len(oracle)),
              "crosstab": crosstabs(oracle),
              "marginLambda0.3": margins(labels.compute_labels(df, lam=0.3)),
              "qoeMedianExamples": qoe_medians(df)}
    out = TRAINING / "reports" / f"{'-'.join(args.runs)}.rq1-crosstab.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"crosstab → {out}")

    fig_heatmap(oracle, DOCS_FIG / "fig7-1-oracle-heatmap.svg")
    fig_pareto(TRAINING / "reports" / "grid-v1.sweep.json", DOCS_FIG / "fig7-2-pareto.svg")
    print(f"figures → {DOCS_FIG}")


if __name__ == "__main__":
    main()
