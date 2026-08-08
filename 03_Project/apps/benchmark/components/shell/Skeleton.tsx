/**
 * CSR의 데이터 도착 전, Streaming SSR의 Suspense fallback.
 *
 * 최종 DOM에는 남지 않으므로 모드 간 DOM 동등성에 영향을 주지 않는다.
 * 다만 LCP 후보가 될 수 있으므로 실제 트리와 시각적 크기를 맞춘다.
 */
export function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <div className="skeleton-title" />
      <div className="skeleton-hero" />
      <div className="skeleton-lines">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton-line" />
        ))}
      </div>
    </div>
  )
}
