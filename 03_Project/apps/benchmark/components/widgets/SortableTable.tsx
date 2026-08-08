'use client'

import { useMemo, useState } from 'react'

type Row = (string | number)[]

/**
 * 정렬 로직이 클라이언트에 있으므로 행 수가 곧 하이드레이션 이후 비용이 된다.
 * 초기 렌더는 정렬하지 않은 원본 순서 — 서버와 동일해야 한다.
 */
export function SortableTable({ columns, rows }: { columns: string[]; rows: Row[] }) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [desc, setDesc] = useState(false)

  const sorted = useMemo(() => {
    if (sortCol === null) return rows
    const copy = [...rows]
    copy.sort((a, b) => {
      const x = a[sortCol]
      const y = b[sortCol]
      const cmp =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y), 'ko')
      return desc ? -cmp : cmp
    })
    return copy
  }, [rows, sortCol, desc])

  const onSort = (i: number) => {
    if (sortCol === i) setDesc((d) => !d)
    else {
      setSortCol(i)
      setDesc(false)
    }
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={c} aria-sort={sortCol === i ? (desc ? 'descending' : 'ascending') : 'none'}>
              <button type="button" onClick={() => onSort(i)}>
                {c}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={String(r[0]) + i}>
            {r.map((cell, j) => (
              <td key={j}>{typeof cell === 'number' ? cell.toLocaleString('ko') : cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
