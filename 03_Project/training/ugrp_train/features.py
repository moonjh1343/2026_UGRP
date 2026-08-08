"""
피처 행렬 구성. `policy/features.ts`의 `toVector()`와 **키·순서가 같아야** 엣지에서
쓰는 증류 트리와 학습 시점 모델이 같은 것을 보고 있다고 말할 수 있다.
"""
from __future__ import annotations

import pandas as pd

from .config import (
    DEVICES,
    FEATURE_ORDER,
    LAB_FEATURE_DEFAULTS,
    MODE_INDEX,
    NETWORKS,
    effective_type_idx,
)


def _condition_frame() -> pd.DataFrame:
    """device × network 조합별 정적 피처. 그리드가 고정한 조건이므로 조인 키로 쓴다."""
    rows = []
    for dev_id, dev in DEVICES.items():
        for net_id, net in NETWORKS.items():
            rows.append(
                {
                    "device": dev_id,
                    "network": net_id,
                    "deviceTier": dev["tier"],
                    "effectiveTypeIdx": effective_type_idx(net["ect"]),
                    "rttMs": net["latency"],
                    "downlinkMbps": net["downlink"],
                }
            )
    return pd.DataFrame(rows)


def build_feature_frame(df: pd.DataFrame, routes: pd.DataFrame, calibration: dict | None = None) -> pd.DataFrame:
    """
    측정 레코드(df) + 라우트 스냅샷(routes) → `FEATURE_ORDER` 열을 가진 DataFrame.

    calibration은 `experiment.json`의 `calibration` 블록(부하 수준별 cpuPct·
    eventLoopP95Ms)이다. 없으면 전부 0(Idle과 동일)으로 채운다 — 그 경우 결과는
    부하 축의 정보를 담지 못한다는 뜻이고, 호출부가 경고해야 한다.
    """
    cond = _condition_frame()
    merged = df.merge(cond, on=["device", "network"], how="left")
    merged = merged.merge(
        routes[["routeType", "routeKey", "mode", "nodeCount", "interactiveCount", "payloadKB",
                "fetchDepth", "fetchDelayMs", "personalizedRatio", "seoWeight", "bundleKB"]],
        on=["routeType", "routeKey", "mode"],
        how="left",
    )

    merged["modeIdx"] = merged["mode"].map(MODE_INDEX)
    missing_mode = merged["modeIdx"].isna()
    if missing_mode.any():
        bad = sorted(merged.loc[missing_mode, "mode"].unique())
        raise ValueError(f"MODE_INDEX에 없는 모드: {bad} — config.py를 policy/모델과 다시 맞춰라")

    if calibration:
        cal_cpu = {level: v.get("cpuPct", 0.0) for level, v in calibration.items()}
        cal_loop = {level: v.get("eventLoopP95Ms", 0.0) for level, v in calibration.items()}
        merged["cpuPct"] = merged["load"].map(cal_cpu).fillna(0.0)
        merged["eventLoopP95Ms"] = merged["load"].map(cal_loop).fillna(0.0)
    else:
        merged["cpuPct"] = 0.0
        merged["eventLoopP95Ms"] = 0.0

    for key, val in LAB_FEATURE_DEFAULTS.items():
        merged[key] = val

    rename = {"modeIdx": "mode_vec"}
    out = pd.DataFrame(index=merged.index)
    out["mode"] = merged["modeIdx"].astype(int)
    out["deviceTier"] = merged["deviceTier"]
    out["deviceMemory"] = merged["deviceMemory"]
    out["hardwareConcurrency"] = merged["hardwareConcurrency"]
    out["effectiveTypeIdx"] = merged["effectiveTypeIdx"]
    out["rttMs"] = merged["rttMs"]
    out["downlinkMbps"] = merged["downlinkMbps"]
    out["saveData"] = merged["saveData"]
    out["prevLcpMs"] = merged["prevLcpMs"]
    out["prevTbtMs"] = merged["prevTbtMs"]
    out["cpuPct"] = merged["cpuPct"]
    out["eventLoopP95Ms"] = merged["eventLoopP95Ms"]
    out["inflight"] = merged["inflight"]
    out["cacheHitRate"] = merged["cacheHitRate"]
    out["routeRps"] = merged["routeRps"]
    out["nodeCount"] = merged["nodeCount"]
    out["interactiveCount"] = merged["interactiveCount"]
    out["payloadKB"] = merged["payloadKB"]
    out["fetchDepth"] = merged["fetchDepth"]
    out["fetchDelayMs"] = merged["fetchDelayMs"]
    out["personalizedRatio"] = merged["personalizedRatio"]
    out["seoWeight"] = merged["seoWeight"]
    out["bundleKB"] = merged["bundleKB"]
    out["isRepeatVisit"] = merged["isRepeatVisit"]

    assert list(out.columns) == FEATURE_ORDER, "FEATURE_ORDER와 실제로 만든 열이 어긋난다"

    missing_route = merged["nodeCount"].isna()
    if missing_route.any():
        n = int(missing_route.sum())
        raise ValueError(
            f"{n}개 행이 라우트 스냅샷과 조인되지 않았다 — route_snapshot.json이 오래됐거나 "
            "라우트 키가 바뀌었을 수 있다. fetch_routes.py를 다시 실행하라."
        )

    return out
