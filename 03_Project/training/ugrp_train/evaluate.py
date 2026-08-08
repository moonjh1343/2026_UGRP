"""
오프라인 평가 (제안서 §7.2, §5.4-6): 오라클 대비 regret, Top-1 일치율, pairwise accuracy.

평가는 개별 반복(행) 단위가 아니라 **(x, mode) 조건 단위**로 한다. 정책이 실제로
하는 일이 조건별 argmin이므로, 노이즈 있는 개별 반복이 아니라 그 조건의 기대
비용(반복 평균)을 놓고 비교해야 정책 품질을 재는 것이 된다. 피처도 반복마다
동일하므로(측정 결과가 아니라 라우트·조건에서 나오는 값) 조건당 대표 행 하나로
충분하다.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

GROUP_KEYS = ["device", "network", "load", "routeType", "routeKey"]


def aggregate_by_condition(df: pd.DataFrame) -> pd.DataFrame:
    """
    (x, mode) 조건당 한 행으로 접는다. `J`는 반복 평균.

    피처 열은 여기 담지 않는다 — 담으려면 라우트 정적 특징(`X`)과 이 함수가 쓰는
    범주형 `mode`(예: "ssr")를 합쳐야 하는데, `X`에는 **같은 이름**으로 모델 입력용
    수치 인코딩 `mode`(정수 인덱스)가 있어 열 이름이 충돌한다. 평가 로직은 애초에
    `J`와 예측값만 보므로 피처가 필요 없다 — 필요해지면 `X`의 `mode`를 다른 이름으로
    바꿔서 합쳐야 한다.
    """
    agg = df.groupby([*GROUP_KEYS, "mode"]).agg(
        J=("J", "mean"),
        J_std=("J", "std"),
        n=("J", "count"),
    )
    return agg.reset_index()


def _per_condition_eval(group: pd.DataFrame, pred_col: str) -> dict:
    group = group.sort_values("mode")
    oracle_idx = group["J"].idxmin()
    pred_idx = group[pred_col].idxmin()

    oracle_mode = group.loc[oracle_idx, "mode"]
    pred_mode = group.loc[pred_idx, "mode"]
    regret = group.loc[pred_idx, "J"] - group.loc[oracle_idx, "J"]

    # pairwise accuracy — 실행 가능 집합 M(x) 안의 모든 쌍
    modes = group["mode"].tolist()
    correct = 0
    total = 0
    for i in range(len(modes)):
        for j in range(i + 1, len(modes)):
            ji, jj = group.iloc[i]["J"], group.iloc[j]["J"]
            pi, pj = group.iloc[i][pred_col], group.iloc[j][pred_col]
            if ji == jj:
                continue  # 동률은 순서가 없어 채점하지 않는다
            total += 1
            if np.sign(ji - jj) == np.sign(pi - pj):
                correct += 1

    return {
        "oracleMode": oracle_mode,
        "predMode": pred_mode,
        "top1": oracle_mode == pred_mode,
        "regret": regret,
        "pairwiseCorrect": correct,
        "pairwiseTotal": total,
        "candidateCount": len(modes),
    }


def evaluate_policy(cond_df: pd.DataFrame, pred_col: str) -> dict:
    """
    cond_df는 `aggregate_by_condition`의 출력에 `pred_col`(그 정책이 각 (x,mode)에
    매긴 예측 비용)이 붙은 프레임이다. `|M(x)|=1`인 조건은 애초에 선택의 여지가
    없으므로 top-1/regret 집계에서 제외한다 — 정책의 실력과 무관한 조건이다.
    """
    rows = []
    for _, group in cond_df.groupby(GROUP_KEYS):
        if len(group) < 2:
            continue
        rows.append(_per_condition_eval(group, pred_col))

    if not rows:
        return {"n": 0}

    res = pd.DataFrame(rows)
    pairwise_total = res["pairwiseTotal"].sum()
    return {
        "n": len(res),
        "top1Rate": res["top1"].mean(),
        "meanRegret": res["regret"].mean(),
        "medianRegret": res["regret"].median(),
        "p95Regret": res["regret"].quantile(0.95),
        "pairwiseAccuracy": (res["pairwiseCorrect"].sum() / pairwise_total) if pairwise_total else float("nan"),
        "detail": res,
    }


def format_report(name: str, result: dict) -> str:
    if result["n"] == 0:
        return f"  {name:<14} 평가 가능한 조건 없음 (|M(x)|>=2인 (x) 그룹이 없다)"
    return (
        f"  {name:<14} n={result['n']:<4} "
        f"top1={result['top1Rate']*100:5.1f}%  "
        f"regret(중앙값)={result['medianRegret']:7.3f}  "
        f"regret(평균)={result['meanRegret']:7.3f}  "
        f"pairwise={result['pairwiseAccuracy']*100:5.1f}%"
    )
