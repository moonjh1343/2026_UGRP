"""
목적함수 라벨: J(x, m) = Σ w_i · z_r(QoE_i) + λ · ServerCost(x, m)   (제안서 §3.1)

두 가지가 원본 정의와 다르게 근사된다. 둘 다 **측정 가능한 것으로 대체한 것**이지
정의를 바꾼 것이 아니다 — 이유를 각 함수 docstring에 남긴다.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .config import DEFAULT_LAMBDA, QOE_WEIGHTS, SERVER_COST_UNIT_DIVISOR

QOE_METRICS = list(QOE_WEIGHTS.keys())


def estimate_render_cost(df: pd.DataFrame) -> pd.DataFrame:
    """
    C_render(m, routeType) — Idle 셀·실제 렌더 발생 행만 골라 평균한다.

    **개별 행의 `serverRenderCpuUs`를 라벨에 직접 쓰면 안 된다.** `process.cpuUsage()`가
    Windows에서 15.625ms 단위로 양자화되어 수 ms짜리 렌더가 대부분 0으로 잡힌다
    (CLAUDE.md, 설계 문서 §7). 실제로 수집된 표본에서도 렌더가 일어난 행(`serverRenderCount`>0)
    인데 `serverRenderCpuUs`가 0인 경우가 흔하다. 이 함수는 **여러 반복의 평균**을 취해
    양자화 잡음을 상쇄한다 — `measure:render` 스크립트가 하는 것과 같은 처리다.

    (mode, routeType) 단위로 묶는다 — 렌더 비용은 모드뿐 아니라 라우트 무게에도
    좌우된다(대시보드형의 하이드레이션 CPU 대 콘텐츠형의 직렬화 비용). 표본이 부족한
    조합은 모드 단위로 폴백한다.
    """
    group_cols = ["mode", "routeType"]

    idle = df[(df["load"] == "idle") & (df["serverRenderCount"] > 0)]
    if idle.empty:
        warnings.warn("Idle·렌더 발생 표본이 없다 — C_render를 추정할 수 없다", stacklevel=2)
        return pd.DataFrame(columns=[*group_cols, "cRenderUs", "n"])

    fine = idle.groupby(group_cols)["serverRenderCpuUs"].agg(["mean", "count"]).reset_index()
    fine = fine.rename(columns={"mean": "cRenderUs", "count": "n"})

    coarse = (
        idle.groupby("mode")["serverRenderCpuUs"]
        .agg(["mean", "count"])
        .reset_index()
        .rename(columns={"mean": "cRenderUsCoarse", "count": "nCoarse"})
    )

    out = fine.merge(coarse, on="mode", how="left")
    # 표본이 5개 미만인 세밀 그룹은 신뢰하지 않고 모드 단위 평균으로 대체한다.
    thin = out["n"] < 5
    out.loc[thin, "cRenderUs"] = out.loc[thin, "cRenderUsCoarse"]
    out.loc[thin, "n"] = out.loc[thin, "nCoarse"]
    return out[[*group_cols, "cRenderUs", "n"]]


def compute_server_cost(df: pd.DataFrame) -> pd.Series:
    """
    ServerCost(x, m) 근사 — 관측된 렌더 여부에 aggregate C_render(m, routeType)를 곱한다.

    제안서의 일반형은 `C_render(m)·missRate(x,m) + C_serve(m) + μ·C_store(m)`이다.
    `missRate`를 §3.1.2의 `1/max(1, rps_r·T)` 공식으로 구하려면 **해당 라우트의 실제
    요청률**이 필요한데, 이 워커의 배경 부하는 측정 라우트를 일부러 피해 가도록
    설계돼 있다(load/profile.json) — 측정 라우트의 rps_r은 사실상 이 측정 요청 하나뿐이라
    공식 자체가 무의미하다. 실트래픽 rps_r은 필드 데이터(10단계)에서만 의미가 생긴다.

    대신 **각 행이 실제로 렌더를 유발했는지**를 직접 관측해 쓴다(`serverRenderCount`>0).
    캐시 축이 셀 정의에서 miss/hit/stale로 이미 분리돼 있으므로, 한 셀 내 반복들의
    렌더-발생 비율이 그 조건에서의 경험적 missRate와 같다 — 공식을 몰라도 관측으로
    대체된다. 렌더가 없었던 행은 캐시 히트로 보고 서빙 비용을 0으로 둔다.

    C_serve(캐시 히트 시에도 드는 서빙 비용)와 C_store(캐시 저장소 점유)는 이 하네스가
    아직 계측하지 않는다 — 전자는 히트 응답의 CPU 델타를, 후자는 모드별 캐시 엔트리
    크기를 재는 별도 계측이 필요하다. 둘 다 0으로 둔다(config.DEFAULT_MU=0과 함께
    이 항은 현재 항상 0이다). **이는 근사가 아니라 미계측이다** — μ가 실측되기 전까지
    C_store 항은 라벨에 반영되지 않는다는 뜻이고, README에 한계로 명시한다.
    """
    cost = estimate_render_cost(df)
    merged = df.merge(cost, on=["mode", "routeType"], how="left")

    rendered = merged["serverRenderCount"] > 0
    server_cost_us = np.where(rendered, merged["cRenderUs"].fillna(0.0), 0.0)

    return pd.Series(server_cost_us / SERVER_COST_UNIT_DIVISOR, index=df.index, name="serverCostMs")


def zscore_per_route(df: pd.DataFrame, col: str) -> pd.Series:
    """
    z_r(QoE_i) — 라우트별 정규화.

    이걸 생략하면 "무거운 페이지 = 무조건 나쁨"이 학습되어 모드 간 비교 신호가
    사라진다(CLAUDE.md, 제안서 §5.4). 표준편차가 0인 라우트(값이 전부 같음)는
    z=0으로 둔다 — 나눗셈 대신.
    """
    grp = df.groupby("routeKey")[col]
    mean = grp.transform("mean")
    std = grp.transform("std").replace(0, np.nan)
    z = (df[col] - mean) / std
    return z.fillna(0.0)


def compute_labels(
    df: pd.DataFrame,
    weights: dict[str, float] | None = None,
    lam: float = DEFAULT_LAMBDA,
) -> pd.DataFrame:
    """
    df에 z-정규화된 QoE 열들과 최종 라벨 `J`를 추가해 돌려준다.

    가중합은 **그 행에 실제로 값이 있는 지표만으로** 재정규화한다. INP는 상호작용
    임계값 미만이면 결측일 수 있는데(설계 문서 §11-23), 결측을 0으로 채우면
    "상호작용이 아주 빨랐다"는 거짓 신호가 되고, 행을 통째로 버리면 그 행의
    다른 정보(LCP·TBT·TTFB)까지 잃는다.
    """
    weights = weights or QOE_WEIGHTS
    out = df.copy()

    for m in QOE_METRICS:
        out[f"z_{m}"] = zscore_per_route(out, m)

    present = out[QOE_METRICS].notna()
    w = pd.Series(weights)
    weighted = sum(out[f"z_{m}"] * present[m] * w[m] for m in QOE_METRICS)
    weight_sum = sum(present[m] * w[m] for m in QOE_METRICS)
    qoe_term = weighted / weight_sum.replace(0, np.nan)

    out["serverCostMs"] = compute_server_cost(out)
    out["qoeTerm"] = qoe_term.fillna(0.0)
    out["J"] = out["qoeTerm"] + lam * out["serverCostMs"]

    dropped = qoe_term.isna().sum()
    if dropped:
        warnings.warn(f"{dropped}개 행이 QoE 지표를 하나도 갖지 않는다 — qoeTerm=0으로 처리했다", stacklevel=2)

    return out
