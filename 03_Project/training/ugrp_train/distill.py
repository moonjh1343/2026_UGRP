"""
증류 — LightGBM 앙상블 → 깊이 5 결정트리 → `policy/model/*.json` 스키마.

엣지(Lambda@Edge)는 이 JSON을 그대로 평가한다(`policy/surrogate.ts`의 `evalTree`).
그 평가기는 `x[node.feature] <= node.threshold`면 왼쪽으로 간다 — sklearn
DecisionTreeRegressor의 분기 규약과 정확히 같으므로 변환이 직접적이다.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeRegressor

from .config import FEATURE_ORDER, MODE_INDEX


def distill_tree(
    X: pd.DataFrame,
    ensemble_target: np.ndarray,
    max_depth: int = 5,
    min_samples_leaf: int = 5,
) -> DecisionTreeRegressor:
    """
    앙상블의 **예측값**을 타깃으로 depth-5 트리를 학습한다(원본 라벨이 아니다) —
    앙상블이 평활화한 함수 모양을 트리가 흉내 내게 하는 것이 증류의 목적이다.
    원본 라벨로 직접 학습하면 앙상블이 걸러낸 노이즈를 트리가 다시 주워 담는다.
    """
    # random_state 고정 — splitter='best'도 동률 분기에서 피처 순열을 난수로
    # 고르므로, 지정하지 않으면 같은 입력에서 실행마다 다른 트리가 나온다.
    # 배포 산출물이 실행마다 달라지면 시드 기록이 재현을 보장하지 못한다.
    tree = DecisionTreeRegressor(max_depth=max_depth, min_samples_leaf=min_samples_leaf, random_state=0)
    tree.fit(X[FEATURE_ORDER], ensemble_target)
    return tree


def _walk(tree: DecisionTreeRegressor, node_id: int, used_features: set[str]) -> dict:
    t = tree.tree_
    if t.children_left[node_id] == t.children_right[node_id]:  # 리프
        return {"leaf": round(float(t.value[node_id][0][0]), 4)}

    feat_name = FEATURE_ORDER[t.feature[node_id]]
    used_features.add(feat_name)
    return {
        "feature": feat_name,
        "threshold": round(float(t.threshold[node_id]), 4),
        "left": _walk(tree, t.children_left[node_id], used_features),
        "right": _walk(tree, t.children_right[node_id], used_features),
    }


def export_tree_json(
    tree: DecisionTreeRegressor,
    version: str,
    distilled_from: dict,
    trained_on: dict,
    warning: str | None = None,
) -> dict:
    """`policy/model/tree.v0.json`과 같은 스키마. `policy/surrogate.ts`가 그대로 읽는다."""
    used_features: set[str] = set()
    root = _walk(tree, 0, used_features)

    return {
        "version": version,
        "distilledFrom": distilled_from,
        "trainedOn": trained_on,
        # maxDepth는 **분기 레벨 수**다 — 예측 1회당 비교 횟수의 상한이고,
        # 엣지 추론 예산(<2ms)의 근거가 되는 양이다. 노드 레벨 수(= 이 값 + 1)와
        # 헷갈리면 예산을 넘긴 트리가 준수한 것처럼 보인다. budget은 설정값,
        # maxDepth는 실제로 자란 깊이 — 데이터가 얕으면 budget보다 작다.
        "maxDepth": int(tree.get_depth()),
        "maxDepthBudget": int(tree.max_depth),
        "target": "J_hat",
        "unit": "라우트별 z-정규화된 QoE 비용 + λ·ServerCost (낮을수록 좋음)",
        "warning": warning,
        "features": sorted(used_features),
        "modeIndex": MODE_INDEX,
        "root": root,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
