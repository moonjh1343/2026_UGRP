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
        #
        # **말없이 폴백하면 안 된다.** 조건 순서가 무작위라 라우트가 적은 슬라이스는
        # 사실상 항상 이 경로를 타는데, 출력만 보면 시간 분할이 적용된 줄 알게 된다 —
        # 미래 누수 방지가 실제로는 없는데 있다고 믿는 것이 문제다.
        import warnings

        warnings.warn(
            f"시간 분할이 퇴화했다(경계에 걸친 라우트가 전체) — 그룹({group_col})-단독 "
            "분할로 폴백한다. 이 분할에는 시간 기준 미래 누수 방지가 없다.",
            stacklevel=2,
        )
        rng = np.random.default_rng(seed)
        # pandas 3.0의 unique()는 ArrowStringArray를 돌려주는데, view 의미론을 가진
        # 배열의 in-place shuffle은 보장이 없다(런타임 경고). ndarray로 복사해 섞는다.
        groups = np.asarray(df[group_col].unique())
        rng.shuffle(groups)
        n_test_groups = max(1, int(len(groups) * test_frac))
        test_groups = set(groups[:n_test_groups])
        test_idx = df.index[df[group_col].isin(test_groups)]
        train_idx = df.index[~df[group_col].isin(test_groups)]

    return train_idx, test_idx
