/**
 * 결정적 상호작용 시퀀스.
 *
 * **INP는 자연 발생하지 않는다.** 상호작용이 없으면 web-vitals의 onINP가 아무것도
 * 확정하지 않아 QoE의 한 축이 통째로 결측된다(제안서 §3.1). 워커가 주입해야 한다.
 *
 * 시퀀스가 결정적이어야 하는 이유는 반복 30회의 분산이 곧 측정 노이즈이기 때문이다.
 * 클릭 대상이 반복마다 달라지면 그 차이가 노이즈에 얹혀 5단계 합격 기준을 스스로 깨뜨린다.
 * 따라서 셀렉터·순서·지연을 유형별로 고정한다.
 *
 * 부수 효과가 하나 더 있다: 상호작용은 하이드레이션이 **끝난 뒤에야** 반응한다.
 * 클릭이 먹히지 않으면 그 자체가 "아직 인터랙티브하지 않다"는 신호이므로,
 * 실패를 조용히 삼키지 않고 세어서 기록한다.
 */

/** 상호작용 사이 간격(ms). INP는 개별 상호작용의 지연을 재므로 겹치면 안 된다. */
const GAP_MS = 120

/**
 * 유형별 시퀀스. 셀렉터는 `components/widgets/`의 실제 구조를 따른다.
 *  - TocToggle    `.toc button`
 *  - ShareButton  `.share button`
 *  - FilterChips  `.chips button`
 *  - SortableTable`.data-table th button`
 *  - SparkChart   `.chart button`
 *  - FormField    `.field input`, `.field select`
 *  - NoteWidget   `.note input`
 */
export const SEQUENCES = {
  content: [
    { action: 'click', selector: '.toc button' },
    { action: 'click', selector: '.share button' },
    { action: 'type', selector: '.note input', text: '측정' },
  ],
  // 아래 유형별 시퀀스는 전부 **실제 사용자 입력**만 쓴다 — 이유는 파일 하단 참조
  list: [
    { action: 'click', selector: '.chips button', nth: 0 },
    { action: 'click', selector: '.chips button', nth: 1 },
    { action: 'scroll', y: 2000 },
  ],
  dashboard: [
    { action: 'click', selector: '.chart button', nth: 0 },
    { action: 'click', selector: '.data-table th button', nth: 0 },
    { action: 'click', selector: '.chips button', nth: 0 },
  ],
  form: [
    { action: 'type', selector: '.field input', nth: 0, text: '측정값' },
    // select는 press로 바꾼다 — selectOption은 값을 코드로 넣을 뿐 상호작용이 아니다
    { action: 'press', selector: '.field select', nth: 0, key: 'ArrowDown' },
    { action: 'type', selector: '.field input', nth: 1, text: '2' },
  ],
  personalized: [
    { action: 'click', selector: '.chips button', nth: 0 },
    { action: 'scroll', y: 1200 },
    { action: 'click', selector: '.chips button', nth: 1 },
  ],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 시퀀스를 실행하고 성공/실패 수를 돌려준다.
 *
 * 실패를 세는 이유: 상호작용이 먹히지 않았다는 것은 하이드레이션이 아직 안 끝났거나
 * 그 위젯이 그 모드에서 섬이 아니라는 뜻이다. 둘 다 **측정 결과의 해석에 필요한 사실**이라
 * 조용히 넘기면 안 된다.
 */
export async function runSequence(page, routeType) {
  const seq = SEQUENCES[routeType] ?? []
  let performed = 0
  const failures = []

  for (const step of seq) {
    try {
      if (step.action === 'scroll') {
        await page.evaluate((y) => window.scrollTo(0, y), step.y)
      } else {
        const locator = page.locator(step.selector).nth(step.nth ?? 0)
        // 짧은 타임아웃 — 여기서 오래 기다리면 그 대기가 LCP 확정 시점을 밀어버린다
        await locator.waitFor({ state: 'visible', timeout: 3000 })

        if (step.action === 'click') {
          await locator.click({ timeout: 3000 })
        } else if (step.action === 'type') {
          /*
           * `fill()`을 쓰면 안 된다 — Playwright는 값을 CDP `Input.insertText`로 넣는데,
           * 이는 사용자 상호작용으로 집계되지 않는다(`interactionId` 없음,
           * `performance.interactionCount` 증가 없음). 즉 **INP가 통째로 결측된다.**
           * 5단계 스모크 테스트에서 폼형만 INP가 없었던 원인이 이것이었고,
           * 하필 폼형의 지배 축이 INP다.
           *
           * click(포인터) + pressSequentially(키보드)는 실제 입력 이벤트를 발생시킨다.
           * fill('')은 값을 비우기 위한 것이라 상호작용일 필요가 없다.
           */
          await locator.click({ timeout: 3000 })
          await locator.fill('', { timeout: 3000 })
          await locator.pressSequentially(step.text, { delay: 20, timeout: 3000 })
        } else if (step.action === 'press') {
          // select는 selectOption 대신 키 입력으로 바꾼다 — 같은 이유다
          await locator.focus({ timeout: 3000 })
          await locator.press(step.key, { timeout: 3000 })
        }
      }
      performed++
      await sleep(GAP_MS)
    } catch (e) {
      failures.push(`${step.action}:${step.selector ?? step.y} — ${String(e).split('\n')[0]}`)
    }
  }

  return { performed, attempted: seq.length, failures }
}
