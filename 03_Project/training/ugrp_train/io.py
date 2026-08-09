"""
데이터 적재.

측정 레코드는 `workers/runs/<name>/results.jsonl`(append-only)에 있고, 라우트 정적
특징은 `scripts/fetch_routes.py`가 만든 스냅샷에 있다. 둘을 분리한 이유: 라우트
테이블은 앱 재빌드 전까지 불변이라 매번 앱에 물을 필요가 없고, 실행 중인 서버가
지금 파일럿 수집을 처리하고 있어 불필요한 부하를 얹을 이유가 없다.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNS_DIR = REPO_ROOT / "03_Project" / "workers" / "runs"
DEFAULT_SNAPSHOT = Path(__file__).resolve().parents[1] / "data" / "route_snapshot.json"


def _read_jsonl(path: Path) -> list[dict]:
    """
    append-only JSONL을 읽는다. **마지막 줄이 잘려 있을 수 있다** — 수집이 34일
    걸리는 규모라 분석은 수집과 겹쳐 돌아가고, 그 순간 워커가 쓰는 중이던 행이
    반쪽만 보인다. 마지막 한 줄만 버리고 나머지는 살린다. 중간 줄이 깨졌다면
    그건 파일 손상이므로 조용히 넘기지 않고 터뜨린다.
    """
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    rows = []
    for i, line in enumerate(lines):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            if i == len(lines) - 1:
                break  # 쓰는 중인 마지막 행
            raise ValueError(f"{path}의 {i + 1}번째 줄이 깨졌다 — 마지막 줄이 아니므로 손상이다")
    return rows


def _read_sharded(run_dir: Path) -> list[dict]:
    """
    S3에서 내려받은 실행을 읽는다.

    클라우드 수집은 셀 하나당 객체 하나를 쓰고, 키가
    `experiment=<e>/dt=<날짜>/shard=<n>/<셀>.jsonl` 이다. `aws s3 sync`로 통째로
    받아오면 `runs/<실험>/dt=.../shard=.../*.jsonl` 모양이 되므로, 단일
    results.jsonl이 없을 때 이쪽으로 넘어온다.

        aws s3 sync s3://<버킷>/experiment=<실험>/ 03_Project/workers/runs/<실험>/

    같은 셀을 다시 잰 경우 날짜 파티션이 달라 객체가 둘 남는다. 어느 쪽을 쓸지는
    `_dedupe_reps`가 (셀, 반복) 최신 우선으로 정한다 — 여기서는 전부 읽는다.

    클라우드 실행에는 done.jsonl이 없다(완료 표시가 DynamoDB에 있다). 그래도 문제가
    없는 이유: S3 객체는 셀이 끝날 때 한 번에 쓰이므로, 객체가 있다는 것 자체가
    그 셀의 반복이 모두 수집됐다는 뜻이다.
    """
    rows = []
    for p in sorted(run_dir.rglob("*.jsonl")):
        if p.name in {"results.jsonl", "done.jsonl"}:
            continue
        rows.extend(_read_jsonl(p))
    return rows


def _keep_completed_cells(df: pd.DataFrame, run_dir: Path) -> pd.DataFrame:
    """
    `done.jsonl`에 없는 셀의 행을 버리고, 같은 (셀, 반복)이 여러 번 있으면 마지막 것만 남긴다.

    수집은 셀 단위로만 완료 표시된다 — 중간에 멈추면 그 셀의 행은 남지만 done에는
    안 들어간다. 재개하면 그 셀을 **처음부터** 다시 재므로, 아무것도 안 하면 같은
    (셀, 반복)이 두 벌 쌓인다. 그 상태로 학습하면 중단 지점 근처의 조건이 조용히
    두 배 가중된다.

    지우는 대신 여기서 거르는 이유는 results.jsonl이 append-only이기 때문이다 —
    수집 중에도 분석이 돌고, 파일을 다시 쓰면 러너의 append와 경합한다.
    """
    done_path = run_dir / "done.jsonl"
    if not done_path.exists() or "cellId" not in df.columns:
        return df

    done = {r["cellId"] for r in _read_jsonl(done_path)}
    incomplete = df[~df["cellId"].isin(done)]
    if len(incomplete):
        warnings.warn(
            f"{run_dir.name}: 완료되지 않은 셀 {incomplete['cellId'].nunique()}개의 "
            f"{len(incomplete)}행을 제외했다 (수집이 중단된 지점) — 재개하면 다시 측정된다",
            stacklevel=3,
        )
    return df[df["cellId"].isin(done)]


def _dedupe_reps(df: pd.DataFrame, run_name: str) -> pd.DataFrame:
    """
    같은 (셀, 반복)이 여러 번 있으면 마지막 것만 남긴다.

    **격리 필터 뒤에 돌려야 한다.** 재수집분이 오염돼 격리되면, 그때는 그 이전의
    깨끗한 측정치가 남아야 한다. 중복 제거를 먼저 하면 이전 것이 이미 버려진 뒤라
    반복 하나를 통째로 잃는다.
    """
    if "rep" not in df.columns or "cellId" not in df.columns:
        return df
    before = len(df)
    # ts 오름차순으로 두고 마지막을 남긴다 = 살아남은 것 중 최신이 이긴다.
    out = df.sort_values("ts").drop_duplicates(subset=["cellId", "rep"], keep="last")
    if before != len(out):
        warnings.warn(
            f"{run_name}: (셀, 반복) 중복 {before - len(out)}행을 제외했다 — "
            "재수집된 셀의 이전 측정치다. 살아남은 것 중 최신만 남긴다",
            stacklevel=3,
        )
    return out


def _drop_quarantined(df: pd.DataFrame, run_dir: Path) -> pd.DataFrame:
    """
    `quarantine.json`의 시간 창에 걸리는 행을 버린다(`workers/quarantine.mjs`가 쓴다).

    측정 중 같은 머신에서 CPU를 쓴 구간 같은, 부하 축이 외생이 아니게 된 시간대다.
    셀 id가 아니라 **시간 창**으로 거르는 이유: 같은 셀을 재수집하면 그 행은 ts가
    더 나중이라 창 밖이고, 셀 단위로 걸렀다면 재수집분까지 같이 버려진다.

    조용히 버리지 않는다 — 몇 행이 왜 빠졌는지 경고로 남긴다. 표본 수가 갑자기
    줄어든 이유를 나중에 추적할 수 있어야 한다.
    """
    path = run_dir / "quarantine.json"
    if not path.exists() or "ts" not in df.columns:
        return df

    windows = json.loads(path.read_text(encoding="utf-8")).get("windows", [])
    if not windows:
        return df

    mask = pd.Series(False, index=df.index)
    for w in windows:
        mask |= (df["ts"] >= w["fromTs"]) & (df["ts"] <= w["toTs"])

    n = int(mask.sum())
    if n:
        reasons = "; ".join(w.get("reason", "(사유 없음)") for w in windows)
        warnings.warn(
            f"{run_dir.name}: 격리 창에 걸린 {n}행을 제외했다 (창 {len(windows)}개) — {reasons}",
            stacklevel=2,
        )
    return df[~mask]


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
        rows = _read_jsonl(results_path) if results_path.exists() else _read_sharded(d)
        if not rows:
            continue
        df = pd.DataFrame(rows)
        df["experiment"] = d.name
        # 순서가 중요하다: 미완료 셀 제거 → 격리 창 제거 → 중복 반복 제거.
        # 중복 제거를 마지막에 둬야 재수집분이 격리됐을 때 이전 깨끗한 행이 남는다.
        df = _keep_completed_cells(df, d)
        df = _drop_quarantined(df, d)
        df = _dedupe_reps(df, d.name)
        if df.empty:
            continue

        # 환경 컬럼은 **항상** 만든다. experiment.json이 없는 실행이 하나라도 섞이면
        # 아래 concat 결과에 컬럼이 없어 환경 비교 자체가 KeyError로 죽는다.
        # 값이 없다는 사실도 정보다 — None으로 남기고 아래에서 경고한다.
        meta_path = d / "experiment.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        df["_env_browser"] = meta.get("env", {}).get("browser", {}).get("version")
        df["_env_next"] = meta.get("env", {}).get("next")
        df["_env_seed"] = meta.get("seeds", {}).get("order")
        if not meta_path.exists():
            warnings.warn(
                f"{d.name}: experiment.json이 없다 — 브라우저·Next 버전을 확인할 수 없다. "
                "클라우드 수집이라면 `aws s3 sync`에 실험 프리픽스 전체가 포함됐는지 보라",
                stacklevel=2,
            )
        frames.append(df)

    if not frames:
        raise ValueError("읽은 실험에 결과 행이 없다 — 아직 수집이 시작되지 않았을 수 있다")

    out = pd.concat(frames, ignore_index=True)

    envs = out[["experiment", "_env_browser", "_env_next", "_env_seed"]].drop_duplicates()
    mixed = envs.groupby(["_env_browser", "_env_next"]).ngroups > 1
    if mixed:
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
