'use client'

import { useState } from 'react'

/** interactiveCount를 늘릴 때 채워지는 위젯. 하이드레이션 비용을 조절하는 노브. */
export function NoteWidget({ label }: { label: string }) {
  const [value, setValue] = useState('')

  return (
    <label className="note">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  )
}
