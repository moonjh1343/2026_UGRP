/** @type {import('next').NextConfig} */
const nextConfig = {
  // 측정 대상이 렌더링 모드 자체이므로, 모드와 직교하는 최적화는 끄거나 고정한다.
  reactStrictMode: false,   // 개발 모드 이중 렌더가 계측을 오염시킨다
  poweredByHeader: false,

  // 번들 크기가 피처이자 측정 대상이다. 모드 간 비교가 가능하도록 압축 설정을 고정한다.
  compress: true,

  // 빌드 산출물에서 모드별 번들 크기를 추출할 수 있도록 유지
  productionBrowserSourceMaps: false,
}

export default nextConfig
