'use client'

import { useState } from 'react'

export function ShareButton({ label }: { label: string }) {
  const [count, setCount] = useState(0)

  return (
    <div className="share">
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        {label}
      </button>
      <span className="count" data-count={count}>
        {count}
      </span>
    </div>
  )
}
