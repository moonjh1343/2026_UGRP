'use client'

import { useState } from 'react'

export function FilterChips({
  label,
  options,
}: {
  label: string
  options: string[]
}) {
  const [selected, setSelected] = useState<string[]>([])

  const toggle = (o: string) =>
    setSelected((prev) => (prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]))

  return (
    <div className="chips" data-selected={selected.length}>
      <span className="chips-label">{label}</span>
      {options.map((o, i) => (
        <button
          key={`${o}-${i}`}
          type="button"
          aria-pressed={selected.includes(o)}
          onClick={() => toggle(o)}
        >
          {o}
        </button>
      ))}
    </div>
  )
}
