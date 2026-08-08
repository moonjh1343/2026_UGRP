"""
데이터 분할. 제안서 §5.4: **시간 기준 분할과 라우트/세션 그룹 분할을 동시에** 적용한다.
같은 세션이 학습·검증에 나뉘면 누수가 생긴다는 것이 원래 취지인데, factorial 랩
수집에는 "세션"이 없다(매 반복이 새 브라우저 컨텍스트) — 대신 **같은 라우트의
반복들이 갈리는 것**이 같은 종류의 누수다. 한 라우트의 어떤 반복은 학습에, 어떤
반복은 검증에 들어가면 모델이 그 라우트의 z-정규화 기준 자체를 외워서 검증
점수가 부풀려진다. 그래서 그룹 키를 세션이 아니라 `routeKey`로 둔다.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


def time_and_group_split(
    df: pd.DataFrame,
    test_frac: float = 0.2,
    time_col: str = "ts",
    group_col: str = "routeKey",
    seed: int = 0,
) -> tuple[pd.Index, pd.Index]:
    """
    먼저 시간 기준으로 뒤쪽 test_frac을 떼어낸다(미래 데이터 누수 방지). 그 경계에서
    라우트가 걸치면 **경계에 걸친 라우트를 통째로 검증 쪽으로** 민다 — 시간 분할이
    라우트를 반으로 가르면 그룹 분할의 의미가 없어지기 때문이다.
    """
    ordered = df.sort_values(time_col)
    cut_idx = int(len(ordered) * (1 - test_frac))
    cut_ts = ordered.iloc[cut_idx][time_col] if len(ordered) else 0

    late_routes = set(ordered.loc[ordered[time_col] >= cut_ts, group_col])
    is_test = df[group_col].isin(late_routes)

    train_idx = df.index[~is_test]
    test_idx = df.index[is_test]

    if len(test_idx) == 0 or len(train_idx) == 0:
        # 라우트 수가 적으면(파일럿 등) 시간 경계가 전부 한쪽으로 쏠릴 수 있다.
        # 이 경우 그룹 단위로만 분할해 최소한의 홀드아웃을 보장한다.
        rng = np.random.default_rng(seed)
        groups = df[group_col].unique()
        rng.shuffle(groups)
        n_test_groups = max(1, int(len(groups) * test_frac))
        test_groups = set(groups[:n_test_groups])
        test_idx = df.index[df[group_col].isin(test_groups)]
        train_idx = df.index[~df[group_col].isin(test_groups)]

    return train_idx, test_idx


def group_kfold_indices(df: pd.DataFrame, n_splits: int, group_col: str = "routeKey"):
    """GroupKFold — 튜닝(Optuna)에서 쓴다. n_splits는 고유 라우트 수를 넘을 수 없다."""
    n_groups = df[group_col].nunique()
    if n_splits > n_groups:
        raise ValueError(f"n_splits({n_splits}) > 고유 라우트 수({n_groups}) — 폴드 수를 줄여라")
    gkf = GroupKFold(n_splits=n_splits)
    return list(gkf.split(df, groups=df[group_col]))
