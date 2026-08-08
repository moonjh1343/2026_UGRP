import type { Route } from '../routes'
import { generateContent } from './content'
import type { Payload } from './types'

export type { ContentPayload, Payload, SectionSpec, WidgetSpec } from './types'

/**
 * 모든 렌더링 모드가 공유하는 단일 데이터 진입점.
 *
 * SSR·SSG·Islands는 이 함수를 서버에서 **직접** 호출하고,
 * CSR은 app/api/data/[type]/[key]/route.ts를 통해 **HTTP로** 호출한다.
 * 두 경로가 다른 코드를 타면 페이로드가 미세하게 갈라져 비교가 오염되므로,
 * 전송로만 둘이고 생성 로직은 하나다.
 */
export async function getData(route: Route): Promise<Payload> {
  // 백엔드 의존성 지연 재현. fetchDepth는 순차 의존 단계이므로 곱해진다.
  if (route.fetchDelayMs > 0) {
    for (let i = 0; i < route.fetchDepth; i++) {
      await delay(route.fetchDelayMs)
    }
  }

  switch (route.type) {
    case 'content':
      return generateContent(route)
    default:
      throw new Error(`아직 구현되지 않은 라우트 유형: ${route.type} (설계 문서 §12 3단계)`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
