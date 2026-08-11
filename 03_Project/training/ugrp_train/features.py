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

    cpuPct의 출처는 우선순위가 있다:

      1. 행 자체의 `serverCpuPct` — run.mjs가 셀 시작 시점에 실측한 **지속 관측값**.
         버스트 캘리브레이션보다 정확하고, 행마다 다르다.
      2. calibration 블록(`experiment.json`) — 로컬 수집의 수준별 캘리브레이션 값.
      3. 둘 다 없는 비-idle 행이 있으면 **실패한다.** 원격 수집(slice-b2)은
         experiment.json의 calibration이 의도적으로 null이라(캘리브레이션이 DynamoDB에만
         남는다), 예전처럼 조용히 0을 채우면 부하 축 피처가 통째로 사라진 데이터셋으로
         학습이 초록색으로 완주한다 — 트리는 cpuPct로 절대 분기하지 않게 되고,
         아무 에러도 없다.

    eventLoopP95Ms는 행 단위 대체 필드가 없어 calibration 블록에서만 온다.
    없으면 0으로 채우고 경고는 호출부 몫이다.
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

    # 1순위: 행 자체의 지속 관측값. idle 행은 null이라(검증기가 기대값 없이는 재지
    # 않는다) 아래 폴백으로 흘러간다.
    if "serverCpuPct" in merged.columns:
        row_cpu = pd.to_numeric(merged["serverCpuPct"], errors="coerce")
    else:
        row_cpu = pd.Series(float("nan"), index=merged.index)

    # 2순위: 수준별 캘리브레이션 블록.
    if calibration:
        cal_cpu = {level: v.get("cpuPct", 0.0) for level, v in calibration.items()}
        cal_loop = {level: v.get("eventLoopP95Ms", 0.0) for level, v in calibration.items()}
        fallback_cpu = merged["load"].map(cal_cpu)
        merged["eventLoopP95Ms"] = merged["load"].map(cal_loop).fillna(0.0)
    else:
        fallback_cpu = pd.Series(float("nan"), index=merged.index)
        merged["eventLoopP95Ms"] = 0.0

    merged["cpuPct"] = row_cpu.fillna(fallback_cpu)

    # 어느 출처도 없는 비-idle 행 — 조용히 0을 채우면 부하 축이 사라진다. 실패가 맞다.
    orphan = merged["cpuPct"].isna() & (merged["load"] != "idle")
    if orphan.any():
        n = int(orphan.sum())
        levels = sorted(merged.loc[orphan, "load"].unique())
        raise ValueError(
            f"{n}개 비-idle 행({levels})에 cpuPct 출처가 없다 — 행에 serverCpuPct가 없고 "
            "experiment.json의 calibration도 null이다. 원격 수집이라면 캘리브레이션이 "
            "DynamoDB(#calibration#<shard>)에만 있다: 그 값을 runs/<실험>/calibration.observed.json"
            "으로 받아오거나, serverCpuPct가 기록된 데이터로 다시 수집하라. "
            "조용히 0을 채우면 부하 축 피처가 통째로 사라진다."
        )
    merged["cpuPct"] = merged["cpuPct"].fillna(0.0)

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
