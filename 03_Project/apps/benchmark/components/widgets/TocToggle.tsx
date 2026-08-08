'use client'

import { useState } from 'react'

/**
 * Islands 모드의 "섬". 인터랙티브 위젯만 클라이언트 그래프에 있다.
 *
 * 초기 렌더 결과가 서버와 클라이언트에서 **반드시 동일**해야 한다.
 * useState 초기값이 브라우저 API(window, matchMedia)에 의존하면
 * 하이드레이션 불일치가 나고 모드 간 DOM 동등성 검증도 깨진다.
 */
export function TocToggle({ items, label }: { items: { id: string; label: string }[]; label: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="toc" data-open={open ? 'true' : 'false'}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      <ol hidden={!open}>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`}>{i.label}</a>
          </li>
        ))}
      </ol>
    </div>
  )
}
