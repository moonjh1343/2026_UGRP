import { renderHydrated } from '@/lib/render/hydrated'
import { REVALIDATE_MS, routesOf } from '@/lib/routes'

/**
 * SSG·ISR만 세그먼트 설정이 다르다. 이것이 헤더 분기가 아니라
 * 경로 분리를 택한 이유다 — dynamic/revalidate는 요청마다 바꿀 수 없다.
 */
export const dynamic = 'force-static'

/**
 * 세그먼트 설정은 Next.js가 **정적 분석**하므로 리터럴이어야 한다.
 * `REVALIDATE_MS / 1000`처럼 계산식을 쓰면 빌드가 실패한다.
 *
 * 따라서 lib/routes.ts의 REVALIDATE_MS와 이 값이 이중 관리된다.
 * 어긋나면 SSG 후보 판정(§3.1.1)과 missRate 계산(§3.1.2)의 T가 달라지므로
 * 아래 단언으로 드리프트를 빌드 시점에 잡는다.
 */
export const revalidate = 60

if (REVALIDATE_MS !== revalidate * 1000) {
  throw new Error(
    `revalidate 불일치: 세그먼트 설정 ${revalidate}s vs REVALIDATE_MS ${REVALIDATE_MS}ms. ` +
      `lib/routes.ts와 이 파일을 함께 수정하라.`,
  )
}

export function generateStaticParams() {
  return routesOf('content').map((r) => ({ slug: r.key }))
}

export default renderHydrated('ssg', 'content')
