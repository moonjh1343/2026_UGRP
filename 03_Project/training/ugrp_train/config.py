"""
학습 파이프라인 상수.

**여기 값들은 JS 쪽 정의의 사본이지 원본이 아니다.** 원본은 아래 세 파일이고,
그쪽이 바뀌면 이쪽도 손으로 맞춰야 한다 — 자동 동기화 장치는 없다.

  workers/lib/grid.mjs                DEVICES, NETWORKS (기기·네트워크 조건 표)
  apps/benchmark/policy/features.ts   toVector() — 서빙 시점 피처 벡터의 키·순서
  apps/benchmark/policy/model/*.json  modeIndex, EFFECTIVE_TYPES 순서

**FEATURE_ORDER가 toVector()와 어긋나면 train-serve skew가 생긴다.** 학습 때 본
피처 순서와 엣지에서 추론할 때의 피처 순서가 다르면, 트리는 조용히 틀린 값을
평가하면서 에러를 내지 않는다 — 가장 발견하기 어려운 종류의 버그다.
"""

# 모드 인덱스. policy/model/tree.v0.json의 modeIndex와 반드시 같아야 한다.
MODE_INDEX = {"csr": 0, "ssr": 1, "stream": 2, "ssg": 3, "islands": 4}
MODES = list(MODE_INDEX.keys())

# effectiveType 순서. policy/features.ts의 EFFECTIVE_TYPES와 동일해야 한다.
# 'unknown'은 인덱스 3(= '4g'와 같은 취급)으로 폴백한다 — features.ts의 규칙과 동일.
EFFECTIVE_TYPES = ["slow-2g", "2g", "3g", "4g"]


def effective_type_idx(ect: str) -> int:
    try:
        return EFFECTIVE_TYPES.index(ect)
    except ValueError:
        return 3


# 기기 등급 — workers/lib/grid.mjs의 DEVICES 사본.
# tier는 결정 계층의 1~4 스케일(1=저사양)과 같다.
DEVICES = {
    "flagship": {"cpu_throttle": 1, "tier": 4},
    "mid": {"cpu_throttle": 2, "tier": 3},
    "low": {"cpu_throttle": 4, "tier": 2},
    "very-low": {"cpu_throttle": 6, "tier": 1},
}

# 네트워크 — workers/lib/grid.mjs의 NETWORKS 사본. downlink는 Mbps, latency는 ms(RTT).
NETWORKS = {
    "5g": {"ect": "4g", "downlink": 100, "latency": 10},
    "lte": {"ect": "4g", "downlink": 25, "latency": 50},
    "3g-fast": {"ect": "3g", "downlink": 1.6, "latency": 150},
    "3g-slow": {"ect": "3g", "downlink": 0.4, "latency": 400},
    "offline-first": {"ect": "slow-2g", "downlink": 0.25, "latency": 900},
}

# policy/features.ts의 toVector()가 만드는 피처 벡터와 **키·순서를 그대로** 맞춘다.
FEATURE_ORDER = [
    "mode",
    "deviceTier",
    "deviceMemory",
    "hardwareConcurrency",
    "effectiveTypeIdx",
    "rttMs",
    "downlinkMbps",
    "saveData",
    "prevLcpMs",
    "prevTbtMs",
    "cpuPct",
    "eventLoopP95Ms",
    "inflight",
    "cacheHitRate",
    "routeRps",
    "nodeCount",
    "interactiveCount",
    "payloadKB",
    "fetchDepth",
    "fetchDelayMs",
    "personalizedRatio",
    "seoWeight",
    "bundleKB",
    "isRepeatVisit",
]

# 랩(factorial) 수집이 시뮬레이션하지 않는 피처 — 고정 기본값.
# 이유는 실제로 그렇기 때문이다: 워커는 반복마다 새 브라우저 컨텍스트를 쓰므로
# 재방문이 없고(isRepeatVisit=0), Client Hints를 흉내 내지 않으므로 deviceMemory·
# hardwareConcurrency가 없고, 세션 프로파일 쿠키 흐름을 타지 않으므로 prevLcp/TbtMs가
# 없다(features.ts의 결측 표기와 같은 -1). 필드 데이터(10단계)가 이 공백을 채운다.
LAB_FEATURE_DEFAULTS = {
    "deviceMemory": 0.0,
    "hardwareConcurrency": 0.0,
    "saveData": 0.0,
    "prevLcpMs": -1.0,
    "prevTbtMs": -1.0,
    "isRepeatVisit": 0.0,
    # 서버 상태 중 그리드가 통제하지 않는 것들.
    #   inflight       — 단일 전경 측정 요청이므로 사실상 0/1. 0으로 둔다.
    #   cacheHitRate   — 앱 전역 적중률. 워커는 이를 시뮬레이션하지 않는다.
    #   routeRps       — 실트래픽 개념. 배경 부하는 측정 라우트를 피해 가도록
    #                     설계되어 있어(load/profile.json), 측정 라우트의 rps_r은
    #                     사실상 이 요청 하나뿐이다. §3.1.2의 missRate 공식을
    #                     쓰지 않고 관측된 렌더 여부로 ServerCost를 직접 추정하는
    #                     이유가 이것이다(labels.py 참조) — 실측 rps_r이 없으면
    #                     공식 자체가 무의미하기 때문이다.
    "inflight": 0.0,
    "cacheHitRate": 0.0,
    "routeRps": 0.0,
}

# QoE 가중치 — 제안서 §3.1의 J(x,m) = Σ w_i·z_r(QoE_i) + λ·ServerCost(x,m).
# 제안서는 가중치 수치를 못박지 않는다. Core Web Vitals의 상대적 비중(LCP·INP가
# 1차 지표, TTFB는 보조)을 참고한 기본값이며 **스윕 대상이다** — --qoe-weights로 덮는다.
QOE_WEIGHTS = {"LCP": 0.4, "INP": 0.3, "TBT": 0.2, "TTFB": 0.1}

# λ, μ — §3.3에 따르면 λ는 배포 후 이중 상승법으로 조정되는 그림자 가격이지,
# 오프라인 학습 시점에 고정할 값이 아니다. 예산 B(예: 평균 CPU 65%)가 아직
# 운영 값으로 정해지지 않았으므로, 여기서는 스윕 가능한 기본값으로만 둔다.
DEFAULT_LAMBDA = 1.0
DEFAULT_MU = 0.0  # C_store 항. 캐시 엔트리 크기를 아직 계측하지 않아 0 — 아래 참조.

# ServerCost의 단위 정합. 렌더 CPU는 µs로 측정되는데 QoE는 z-score라 스케일이
# 없다. µs를 그대로 더하면 ServerCost가 항상 지배해 QoE 항이 뭉개진다.
# ms로 낮춰 λ가 다루기 쉬운 범위에 오게 한다. "정답 스케일"이 아니라 공학적
# 편의이며, λ 스윕으로 실제 영향력을 조정한다.
SERVER_COST_UNIT_DIVISOR = 1000.0  # µs → ms

MODE_TABLE_PATH_HINT = (
    "route_snapshot.json — scripts/fetch_routes.py로 생성. bundleKB는 "
    "apps/benchmark/policy/bundles.generated.json에서 (모드, 유형) 단위로 온다 "
    "— 인스턴스 단위가 아니다(policy/routeTable.ts의 bundleFor()와 동일)."
)
