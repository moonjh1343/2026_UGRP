"""
LightGBM 회귀 + pairwise ranking 결합 손실(제안서 §4.1, §4.2), 앙상블 불확실성(§4.3),
기준선(§4.1)의 파이썬 구현.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import lightgbm as lgb

from .config import DEVICES, MODE_INDEX, NETWORKS

DEFAULT_PARAMS = {
    "objective": "regression",  # 커스텀 목적함수를 쓸 때도 lgb가 초기값 계산에 참고한다
    "num_leaves": 31,
    "learning_rate": 0.05,
    "min_data_in_leaf": 5,  # 파일럿처럼 표본이 적을 때 과적합 리프를 막는다
    "verbosity": -1,
}


def _group_ids(meta: pd.DataFrame) -> np.ndarray:
    """
    x-그룹 id — 모드를 뺀 조건. **같은 그룹의 행들이 pairwise 항의 비교 대상**이다.

    반복(rep)은 그룹 키에 넣지 않는다. 한 x 아래 여러 모드를 같은 시점에 나란히
    측정한 게 아니라 모드별로 독립된 반복을 모은 것이므로(run.mjs는 셀 단위로
    돈다), "같은 rep"끼리 짝지을 근거가 없다. 대신 **반복은 J(x,m)의 노이즈 있는
    실현치**로 보고, 같은 x 아래 모드가 다른 행이면 무엇이든 비교 대상으로 삼는다.
    """
    key = (
        meta["device"].astype(str)
        + "|"
        + meta["network"].astype(str)
        + "|"
        + meta["load"].astype(str)
        + "|"
        + meta["routeType"].astype(str)
        + "|"
        + meta["routeKey"].astype(str)
    )
    return key.astype("category").cat.codes.to_numpy()


def make_pairwise_mse_objective(y_true: np.ndarray, group_ids: np.ndarray, alpha: float, epsilon: float):
    """
    L = L_MSE + α · Σ_{(i,j) 같은 x, 다른 모드} max(0, ε − (ŷ_j−ŷ_i)·sign(y_j−y_i))

    유도 (그룹 내 순서 없는 쌍 (i,j), s_ij = sign(y_j − y_i)):
      u_ij = ε − s_ij·(ŷ_j − ŷ_i)
      ∂term/∂ŷ_i =  s_ij · 1[u_ij > 0]
      ∂term/∂ŷ_j = −s_ij · 1[u_ij > 0]

    힌지의 2계 도함수는 꺾인 점을 빼면 0이라 헤시안 기여를 0으로 둔다. MSE 항의
    헤시안(=1)이 항상 함께 있으므로 총 헤시안이 0이 되어 뉴턴 스텝이 무너지는
    일은 없다.

    그룹별로 numpy 브로드캐스팅으로 pairwise 행렬을 한 번에 계산한다 — 그룹마다
    Python 반복문으로 쌍을 도는 것은 전체 그리드(31만 행) 규모에서 감당이 안 된다.
    """

    def objective(preds: np.ndarray, dataset: lgb.Dataset):
        y = dataset.get_label() if y_true is None else y_true
        grad = preds - y  # MSE
        hess = np.ones_like(preds)

        for gid in np.unique(group_ids):
            idx = np.where(group_ids == gid)[0]
            if idx.size < 2:
                continue
            yi = y[idx]
            pi = preds[idx]

            dy = yi[None, :] - yi[:, None]  # y_j - y_i
            s = np.sign(dy)
            dp = pi[None, :] - pi[:, None]  # pred_j - pred_i
            u = epsilon - s * dp
            active = (u > 0) & (s != 0)  # 같은 라벨(s=0)인 쌍은 순서가 없어 제외

            # active[i,j]가 참이면 grad[i] += alpha*s_ij, grad[j] += -alpha*s_ij
            contrib_i = np.where(active, s, 0.0).sum(axis=1)  # i 역할로 받는 기여
            contrib_j = np.where(active, s, 0.0).sum(axis=0)  # j 역할로 받는 기여(부호 반대)
            grad[idx] += alpha * (contrib_i - contrib_j)

        return grad, hess

    return objective


def train_lightgbm(
    X: pd.DataFrame,
    y: np.ndarray,
    meta: pd.DataFrame,
    seed: int = 0,
    alpha: float = 0.3,
    epsilon: float = 0.1,
    num_boost_round: int = 200,
    params: dict | None = None,
) -> lgb.Booster:
    """단일 부스터. alpha=0이면 순수 MSE(비교용)."""
    p = {**DEFAULT_PARAMS, **(params or {}), "seed": seed}
    dtrain = lgb.Dataset(X, label=y, free_raw_data=False)

    if alpha > 0:
        # LightGBM 4.x는 커스텀 목적함수를 fobj가 아니라 params['objective']에
        # 콜러블로 직접 받는다(3.x의 fobj는 제거됐다).
        group_ids = _group_ids(meta)
        p["objective"] = make_pairwise_mse_objective(y, group_ids, alpha, epsilon)

    booster = lgb.train(p, dtrain, num_boost_round=num_boost_round)
    return booster


def train_ensemble(
    X: pd.DataFrame,
    y: np.ndarray,
    meta: pd.DataFrame,
    n_seeds: int = 5,
    **kwargs,
) -> list[lgb.Booster]:
    """서로 다른 시드로 학습한 부스터 N개 — 앙상블 분산이 불확실성 추정치가 된다(§4.3)."""
    return [train_lightgbm(X, y, meta, seed=s, **kwargs) for s in range(n_seeds)]


def ensemble_predict(boosters: list[lgb.Booster], X: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(평균 예측, 표준편차). 표준편차는 마진 폴백 τ 재추정과 밴딧 탐색 보너스의 재료다."""
    preds = np.stack([b.predict(X) for b in boosters], axis=0)
    return preds.mean(axis=0), preds.std(axis=0)


# ----------------------------------------------------------------- 기준선

def rule_based_predict_mode(raw: pd.DataFrame, candidate_modes: list[list[str]]) -> list[str]:
    """
    `policy/policies.ts`의 `ruleBased` 정책을 그대로 옮긴 것 — 실무 임계값 규칙 기준선.
    raw는 device/network 원본 열(deviceTier, effectiveType 등 파생 전)을 가진 프레임이다.
    """
    out = []
    for (_, row), cands in zip(raw.iterrows(), candidate_modes):
        dev = DEVICES[row["device"]]
        net = NETWORKS[row["network"]]
        weak = dev["tier"] <= 2 or net["ect"] in ("3g", "2g")
        slow_net = net["ect"] == "slow-2g"
        if slow_net and "ssg" in cands:
            out.append("ssg")
        elif weak and "ssr" in cands:
            out.append("ssr")
        elif "csr" in cands:
            out.append("csr")
        else:
            out.append(cands[0])
    return out
