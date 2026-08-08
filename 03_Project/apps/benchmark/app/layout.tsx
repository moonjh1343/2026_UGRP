import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '적응형 렌더링 벤치마크',
  description: 'SUT — 5개 렌더링 모드를 단일 컴포넌트 정의로 제공',
}

/**
 * 1단계에서는 동적 API(headers/cookies)를 쓰지 않는다.
 * 하나라도 쓰면 SSG 경로가 강제로 동적 렌더가 되어 모드 구분이 무너진다.
 *
 * 상관 ID 주입은 2단계에서 추가하되, SSG는 요청 전에 렌더되므로
 * HTML에 요청별 cid를 심을 수 없다 — 엣지에서 주입하는 방식이 필요하다.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
