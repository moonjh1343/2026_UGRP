import type { Metadata } from 'next'
import { Beacon } from '@/components/instrument/Beacon'
import { HydrationWatch } from '@/components/instrument/HydrationWatch'
import './globals.css'

export const metadata: Metadata = {
  title: '적응형 렌더링 벤치마크',
  description: 'SUT — 5개 렌더링 모드를 단일 컴포넌트 정의로 제공',
}

/**
 * 레이아웃은 동적 API(headers/cookies)를 **쓰지 않는다.**
 * 하나라도 쓰면 SSG 경로가 강제로 동적 렌더가 되어 모드 구분이 무너진다.
 *
 * 상관 ID는 HTML에 심지 않고 Server-Timing 헤더로 전달한다. SSG는 요청 전에
 * 렌더되어 본문에 요청별 값을 넣을 수 없기 때문이다(components/instrument/Beacon.tsx).
 *
 * Beacon은 클라이언트 컴포넌트지만 동적 API를 쓰지 않으므로 정적 생성을 깨지
 * 않는다. HydrationWatch는 인라인 <script>를 렌더하는 서버 컴포넌트다 —
 * 하이드레이션 **전에** 오류 리스너가 설치되어야 하기 때문(파일 주석 참조).
 * 둘 다 #app-root 바깥에 있어 DOM 동등성 검증에도 영향을 주지 않는다.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <HydrationWatch />
        {children}
        <Beacon />
      </body>
    </html>
  )
}
