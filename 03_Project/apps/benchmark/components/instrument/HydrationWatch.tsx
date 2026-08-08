'use client'

import { useEffect } from 'react'

/**
 * 하이드레이션 오류 카운터. 제안서 §3.5의 서킷 브레이커는
 * "하이드레이션 오류율 급증 시 전 트래픽 기본 모드로 복귀"를 규정하므로,
 * 그 판단 근거가 되는 지표를 앱이 내보내야 한다.
 *
 * React는 하이드레이션 불일치를 console.error로 보고하므로 이를 가로챈다.
 * 오류 바운더리는 렌더 예외만 잡고 불일치 경고는 잡지 못한다.
 */
export function HydrationWatch() {
  useEffect(() => {
    const w = window as unknown as { __hydrationErrors?: number }
    w.__hydrationErrors ??= 0

    const original = console.error
    console.error = (...args: unknown[]) => {
      const text = String(args[0] ?? '')
      if (
        text.includes('Hydration') ||
        text.includes('hydrat') ||
        text.includes('did not match')
      ) {
        w.__hydrationErrors = (w.__hydrationErrors ?? 0) + 1
      }
      original.apply(console, args as never)
    }

    return () => {
      console.error = original
    }
  }, [])

  return null
}
