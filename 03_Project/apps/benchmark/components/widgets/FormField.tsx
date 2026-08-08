'use client'

import { useMemo, useState } from 'react'
import type { FieldSpec } from '@/lib/data'

/**
 * 폼형의 INP 원천.
 *
 * 입력마다 패턴 검증이 돌고, 필드 수만큼 하이드레이션 대상이 늘어난다.
 * 정규식은 useMemo로 필드당 한 번 컴파일하지만, 그 컴파일 자체가
 * 하이드레이션 시점 비용이다.
 *
 * 초기 렌더는 빈 값·오류 없음으로 서버와 동일하다.
 */
export function FormField({ field }: { field: FieldSpec }) {
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)

  const regex = useMemo(
    () => (field.pattern ? new RegExp(field.pattern) : null),
    [field.pattern],
  )

  const error = useMemo(() => {
    if (!touched) return null
    if (field.required && value.trim() === '') return '필수 항목입니다'
    if (value !== '' && regex && !regex.test(value)) return '형식이 올바르지 않습니다'
    if (value.length > field.maxLength) return `${field.maxLength}자 이내로 입력하세요`
    return null
  }, [touched, value, regex, field.required, field.maxLength])

  const describedBy = `${field.id}-help${error ? ` ${field.id}-err` : ''}`

  return (
    <div className="field" data-invalid={error ? 'true' : 'false'}>
      <label htmlFor={field.id}>
        {field.label}
        {field.required ? <abbr title="필수">*</abbr> : null}
      </label>

      {field.kind === 'select' ? (
        <select
          id={field.id}
          value={value}
          aria-describedby={describedBy}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
        >
          <option value="">선택</option>
          {field.options.map((o, i) => (
            <option key={`${o}-${i}`} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea
          id={field.id}
          value={value}
          rows={3}
          maxLength={field.maxLength}
          aria-describedby={describedBy}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      ) : (
        <input
          id={field.id}
          type={field.kind}
          value={value}
          maxLength={field.maxLength}
          aria-describedby={describedBy}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      )}

      <small id={`${field.id}-help`} className="help">
        {field.help}
      </small>
      {error ? (
        <small id={`${field.id}-err`} className="error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  )
}
