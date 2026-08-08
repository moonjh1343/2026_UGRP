/**
 * 통계 유틸 — 5단계 합격 기준의 실체.
 *
 * 판단해야 하는 것은 "반복 30회의 분산이 모드 간 차이보다 작은가"이고,
 * 그 답은 평균이 아니라 **강건 통계**로 내야 한다. 웹 성능 측정은 꼬리가 두껍다 —
 * GC 한 번, 백그라운드 프로세스 한 번이 평균을 통째로 옮긴다.
 */

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 중앙값 절대 편차. 표준편차와 달리 이상치 하나에 끌려가지 않는다. */
export function mad(xs) {
  const med = median(xs)
  return median(xs.map((x) => Math.abs(x - med)))
}

/** 정규분포에서 MAD × 1.4826 ≈ σ. 서로 다른 지표의 산포를 같은 축에서 비교하기 위한 환산. */
export const MAD_TO_SD = 1.4826

/**
 * MAD 기준 3σ 이상치 제거 (제안서 §5.2).
 *
 * MAD가 0이면(값이 거의 동일하면) 아무것도 제거하지 않는다 — 이 경우 모든 값이
 * 중앙값과 같아서 정상적인 데이터인데, 나눗셈을 그대로 하면 전부 이상치가 된다.
 */
export function removeOutliers(xs, k = 3) {
  const values = xs.filter(Number.isFinite)
  const med = median(values)
  const scale = mad(values) * MAD_TO_SD
  if (!Number.isFinite(scale) || scale === 0) return { kept: values, removed: [] }

  const kept = []
  const removed = []
  for (const x of values) {
    if (Math.abs(x - med) / scale > k) removed.push(x)
    else kept.push(x)
  }
  return { kept, removed }
}

/** 강건 산포 추정치(MAD 기반). */
export function robustSd(xs) {
  return mad(xs) * MAD_TO_SD
}

/**
 * 중앙값의 표준오차 근사. 부트스트랩 대신 점근식을 쓴다 —
 * n=30에서 부트스트랩과 실질적 차이가 없고, 재현성 문제(난수)가 없다.
 */
export function seMedian(xs) {
  const n = xs.filter(Number.isFinite).length
  if (n < 2) return NaN
  return (1.2533 * robustSd(xs)) / Math.sqrt(n)
}

/**
 * 5단계 합격 판정.
 *
 * `분산비 = pooled_within_sd / (max_median − min_median)`
 *
 * 이 형태를 쓰는 이유: "모든 모드 쌍이 통계적으로 분리되는가"를 기준으로 삼으면 안 된다.
 * 3단계 실측에서 대시보드·폼·개인화형은 **상위 3개 모드가 실제로 노이즈 안에 있었고**,
 * 그것은 측정 실패가 아니라 참인 발견이다(그래서 마진 폴백이 필요하다). 5단계가 물어야
 * 하는 것은 "그 결론을 내릴 만큼 반복 노이즈가 작은가"이지 "차이가 항상 존재하는가"가 아니다.
 */
export function varianceVerdict(byMode, { threshold = 0.5 } = {}) {
  const entries = Object.entries(byMode).filter(([, xs]) => xs.filter(Number.isFinite).length >= 2)
  if (entries.length < 2) return null

  const medians = entries.map(([mode, xs]) => ({ mode, med: median(xs), n: xs.length }))
  const spread = Math.max(...medians.map((m) => m.med)) - Math.min(...medians.map((m) => m.med))

  // 모드별 산포를 자유도 가중으로 합친다
  let num = 0
  let den = 0
  for (const [, xs] of entries) {
    const sd = robustSd(xs)
    if (!Number.isFinite(sd)) continue
    num += sd * sd * (xs.length - 1)
    den += xs.length - 1
  }
  const pooledSd = den > 0 ? Math.sqrt(num / den) : NaN
  const ratio = spread === 0 ? Infinity : pooledSd / spread

  const sorted = [...medians].sort((a, b) => a.med - b.med)

  /**
   * 인접 쌍이 95%에서 분리되는가. 중앙값 차이가 두 표준오차 합의 1.96배를 넘으면 분리로 본다.
   */
  const pairs = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const seSum = seMedian(byMode[a.mode]) + seMedian(byMode[b.mode])
    pairs.push({
      lower: a.mode,
      upper: b.mode,
      gap: b.med - a.med,
      separated: b.med - a.med > 1.96 * seSum,
    })
  }

  /*
   * 분해능 — 1·2위 간극 대비 노이즈.
   *
   * `ratio`(전체 폭 기준)만 보면 안 되는 이유: CSR처럼 혼자 3배 떨어진 모드가 하나만 있어도
   * 폭이 그것에 지배되어 나머지 모드가 전혀 구분되지 않아도 통과한다. 정책이 실제로 하는
   * 일은 argmin이므로 **순위 맨 위를 분해할 수 있는가**가 진짜 질문이다.
   *
   * 다만 이 값은 합격 조건이 아니다. 상위 두 모드가 실제로 동률인 것은 참인 발견이고
   * (그래서 τ가 필요하다), 그 경우 분해능은 정의상 무한대가 된다.
   */
  const topGap = pairs[0]?.gap ?? NaN
  const resolution = topGap > 0 ? pooledSd / topGap : Infinity

  return {
    medians: sorted,
    spread,
    pooledSd,
    ratio,
    pass: ratio < threshold,
    threshold,
    best: sorted[0]?.mode,
    pairs,
    topGap,
    resolution,
    separatedPairs: pairs.filter((p) => p.separated).length,
    topPairSeparated: pairs[0]?.separated ?? false,
  }
}
