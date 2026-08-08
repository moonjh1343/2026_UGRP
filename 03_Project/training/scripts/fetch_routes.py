"""
라우트 정적 특징 스냅샷 생성.

`/api/internal/routes`에 GET 하나(읽기 전용, `force-dynamic`이라 캐시 문제 없음)만
날린다 — 지금 이 서버는 6단계 수집을 처리 중이므로, 그 흐름을 막지 않는 가벼운
호출 하나만 허용한다. bundleKB는 API가 주지 않으므로 `policy/bundles.generated.json`을
파일시스템에서 직접 읽어 붙인다(서버를 다시 두드리지 않는다).

사용: python scripts/fetch_routes.py [--base http://127.0.0.1:3000]
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parents[3]
BUNDLES_PATH = REPO_ROOT / "03_Project" / "apps" / "benchmark" / "policy" / "bundles.generated.json"
OUT_PATH = Path(__file__).resolve().parents[1] / "data" / "route_snapshot.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3000")
    args = ap.parse_args()

    with urllib.request.urlopen(f"{args.base}/api/internal/routes", timeout=10) as res:
        routes_payload = json.load(res)

    bundles = {}
    if BUNDLES_PATH.exists():
        bundles_raw = json.loads(BUNDLES_PATH.read_text(encoding="utf-8"))
        bundles = bundles_raw.get("byModeType", {})
        if not bundles:
            print(f"경고: {BUNDLES_PATH}에 byModeType이 비어 있다 — bundleKB가 전부 0이 된다.")
            print("       apps/benchmark에서 npm run analyze:routes를 먼저 실행하라.")
    else:
        print(f"경고: {BUNDLES_PATH} 없음 — bundleKB가 전부 0이 된다.")

    snapshot = {
        "fetchedFrom": args.base,
        "totalCandidateCells": routes_payload["totalCandidateCells"],
        "thetaP": routes_payload["thetaP"],
        "routes": routes_payload["routes"],
        "bundleByModeType": bundles,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"라우트 {len(snapshot['routes'])}종 → {OUT_PATH}")


if __name__ == "__main__":
    main()
