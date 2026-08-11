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
    # **확률적 요소가 없으면 앙상블이 앙상블이 아니다.** bagging·feature_fraction
    # 없이는 LightGBM이 시드와 무관하게 결정적이라, 시드 0~4의 부스터 5개가
    # 사실상 동일하고 ensemble_predict의 std(§4.3 불확실성, τ 재추정의 재료)가
    # 상수 0이 된다 — 학습 비용만 5배인 채 그럴듯한 숫자를 내는 조용한 실패.
    "feature_fraction": 0.9,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    # **같은 시드는 같은 모델이어야 한다.** bagging을 켜자 스레딩 비결정성이
    # 드러나 연속 두 실행의 증류 트리가 피처 구성까지 달랐다 — "모든 시드를
    # 기록한다"는 재현성 요구가 시드로 재현이 안 되면 공허하다. deterministic은
    # 히스토그램 경합을 막고, force_row_wise는 행/열 자동 선택의 비결정성을 없앤다.
    "deterministic": True,
    "force_row_wise": True,
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


def make_pairwise_mse_objective(
    y_true: np.ndarray, group_ids: np.ndarray, mode_ids: np.ndarray, alpha: float, epsilon: float
):
    """
    L = L_MSE + α · mean_{(i,j) 같은 x, **다른 모드**} max(0, ε − (ŷ_j−ŷ_i)·sign(y_j−y_i))

    유도 (그룹 내 순서 없는 쌍 (i,j), s_ij = sign(y_j − y_i)):
      u_ij = ε − s_ij·(ŷ_j − ŷ_i)
      ∂term/∂ŷ_i =  s_ij · 1[u_ij > 0]
      ∂term/∂ŷ_j = −s_ij · 1[u_ij > 0]

    **다른 모드끼리만 짝짓는다.** 학습 대상은 모드 간 순위지, 같은 모드 반복들
    사이의 노이즈 순서가 아니다 — 반복끼리 짝지으면 그룹당 O(reps²)의 무의미한
    쌍이 생기고, cpuPct가 행별 실측이 된 뒤로는 같은 모드의 반복이 서로 다른
    리프로 갈라질 수 있어 그 노이즈 순서가 실제 그래디언트가 된다.

    **행별 참여 쌍 수로 정규화한다.** 합으로 두면 그래디언트가 그룹 크기(reps ×
    모드 × 캐시 상태)에 비례해 α의 의미가 데이터 규모에 따라 바뀌고, 캐시 축이
    있는 ssg가 3배 가중을 받는다. 평균이면 행당 pairwise 기여가 [−α, α]로
    고정되어 MSE 항(O(1))과의 균형이 규모 불변이다.

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
            mi = mode_ids[idx]

            dy = yi[None, :] - yi[:, None]  # y_j - y_i
            s = np.sign(dy)
            dp = pi[None, :] - pi[:, None]  # pred_j - pred_i
            u = epsilon - s * dp
            cross = mi[None, :] != mi[:, None]  # 다른 모드끼리만
            considered = cross & (s != 0)  # 같은 라벨(s=0)인 쌍은 순서가 없어 제외
            active = considered & (u > 0)

            sig = np.where(active, s, 0.0)
            # sig는 반대칭(s 반대칭 × active 대칭)이라 행 k의 i·j 역할 기여가
            # 정확히 두 배로 겹친다 — 한 번만 센다(행 기준 합).
            row_contrib = sig.sum(axis=1)
            n_pairs = np.maximum(1, considered.sum(axis=1))
            grad[idx] += alpha * row_contrib / n_pairs

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
        mode_ids = meta["mode"].astype("category").cat.codes.to_numpy()
        p["objective"] = make_pairwise_mse_objective(y, group_ids, mode_ids, alpha, epsilon)

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

def rule_based_predict_mode(
    raw: pd.DataFrame, candidate_modes: list[list[str]], cpu_pct: np.ndarray | None = None
) -> list[str]:
    """
    `policy/policies.ts`의 `ruleBased` 정책을 그대로 옮긴 것 — 실무 임계값 규칙 기준선.
    raw는 device/network 원본 열(deviceTier, effectiveType 등 파생 전)을 가진 프레임이다.

    cpu_pct는 조건별 서버 CPU(%). TS 규칙의 `busy = cpuPct > 80 → ssr` 분기를
    나르는 값이다 — 이것이 빠져 있던 동안 high 부하(90%) 셀 전체에서 TS 규칙은
    ssr을, 이 기준선은 csr을 골라 rule-based의 성적이 실제 배포될 규칙의 것이
    아니었다. saveData 조건은 랩 그리드에 축이 없어(항상 off) 생략이 무해하다.
    """
    out = []
    for i, ((_, row), cands) in enumerate(zip(raw.iterrows(), candidate_modes)):
        dev = DEVICES[row["device"]]
        net = NETWORKS[row["network"]]
        weak = dev["tier"] <= 2 or net["ect"] in ("3g", "2g")
        slow_net = net["ect"] == "slow-2g"
        busy = cpu_pct is not None and float(cpu_pct[i]) > 80
        if slow_net and "ssg" in cands:
            out.append("ssg")
        elif (weak or busy) and "ssr" in cands:
            out.append("ssr")
        elif "csr" in cands:
            out.append("csr")
        else:
            out.append(cands[0])
    return out
