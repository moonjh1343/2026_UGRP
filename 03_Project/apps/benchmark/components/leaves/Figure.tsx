/**
 * 지시어 없음 — 서버 그래프(Islands)와 클라이언트 그래프(CSR/SSR/Stream/SSG)
 * 양쪽에서 그대로 재사용된다.
 *
 * 제약: 서버 전용 API(fs, DB)를 쓸 수 없고 async일 수 없다.
 * 데이터는 전부 props로 내려오므로 실제 문제는 없다.
 */
export function Figure({
  src,
  width,
  height,
  alt,
}: {
  src: string
  width: number
  height: number
  alt: string
}) {
  return (
    <figure className="hero">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={width} height={height} alt={alt} fetchPriority="high" />
      <figcaption>{alt}</figcaption>
    </figure>
  )
}
