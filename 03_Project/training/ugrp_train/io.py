"""
데이터 적재.

측정 레코드는 `workers/runs/<name>/results.jsonl`(append-only)에 있고, 라우트 정적
특징은 `scripts/fetch_routes.py`가 만든 스냅샷에 있다. 둘을 분리한 이유: 라우트
테이블은 앱 재빌드 전까지 불변이라 매번 앱에 물을 필요가 없고, 실행 중인 서버가
지금 파일럿 수집을 처리하고 있어 불필요한 부하를 얹을 이유가 없다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNS_DIR = REPO_ROOT / "03_Project" / "workers" / "runs"
DEFAULT_SNAPSHOT = Path(__file__).resolve().parents[1] / "data" / "route_snapshot.json"


def load_runs(names: list[str] | None = None) -> pd.DataFrame:
    """
    `runs/*/results.jsonl`을 읽어 하나의 DataFrame으로 합친다.

    names가 None이면 `runs/` 아래 모든 실험을 읽는다. 각 행에 실험 이름과 그
    실험의 환경 메타데이터(브라우저·Next 버전, 캘리브레이션)를 함께 붙인다 —
    서로 다른 실행에서 모은 데이터를 나중에 합칠 때, 환경이 갈렸는지 사후에
    구분할 수 있어야 하기 때문이다(설계 문서의 버전 기록 요구사항과 같은 이유).
    """
    if not RUNS_DIR.exists():
        raise FileNotFoundError(f"{RUNS_DIR} 없음 — 아직 아무 실험도 실행되지 않았다")

    run_dirs = sorted(d for d in RUNS_DIR.iterdir() if d.is_dir())
    if names is not None:
        wanted = set(names)
        run_dirs = [d for d in run_dirs if d.name in wanted]
        missing = wanted - {d.name for d in run_dirs}
        if missing:
            raise FileNotFoundError(f"실험 없음: {missing}")

    frames = []
    for d in run_dirs:
        results_path = d / "results.jsonl"
        if not results_path.exists():
            continue
        rows = [json.loads(line) for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not rows:
            continue
        df = pd.DataFrame(rows)
        df["experiment"] = d.name

        meta_path = d / "experiment.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            df["_env_browser"] = meta.get("env", {}).get("browser", {}).get("version")
            df["_env_next"] = meta.get("env", {}).get("next")
            df["_env_seed"] = meta.get("seeds", {}).get("order")
        frames.append(df)

    if not frames:
        raise ValueError("읽은 실험에 결과 행이 없다 — 아직 수집이 시작되지 않았을 수 있다")

    out = pd.concat(frames, ignore_index=True)

    envs = out[["experiment", "_env_browser", "_env_next", "_env_seed"]].drop_duplicates()
    mixed = envs.groupby(["_env_browser", "_env_next"]).ngroups > 1
    if mixed:
        import warnings

        warnings.warn(
            "합친 실험들의 환경(브라우저·Next 버전)이 갈린다. 같은 데이터셋으로 볼 수 있는지 "
            f"확인하라:\n{envs.to_string(index=False)}",
            stacklevel=2,
        )

    return out


def load_route_snapshot(path: Path = DEFAULT_SNAPSHOT) -> pd.DataFrame:
    """라우트 정적 특징 + 모드별 번들 크기. 행 하나 = (routeType, routeKey, mode)."""
    if not path.exists():
        raise FileNotFoundError(f"{path} 없음 — 먼저 scripts/fetch_routes.py를 실행하라")
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for r in raw["routes"]:
        for mode in r["candidateModes"]:
            rows.append(
                {
                    "routeType": r["type"],
                    "routeKey": r["key"],
                    "mode": mode,
                    "nodeCount": r["nodeCount"],
                    "interactiveCount": r["interactiveCount"],
                    "payloadKB": r["payloadKB"],
                    "fetchDepth": r["fetchDepth"],
                    "fetchDelayMs": r["fetchDelayMs"],
                    "personalizedRatio": r["personalizedRatio"],
                    "seoWeight": r["seoWeight"],
                    "hardPinned": r["hardPinned"],
                    "bundleKB": raw["bundleByModeType"].get(f"{mode}/{r['type']}", 0.0),
                }
            )
    return pd.DataFrame(rows)
