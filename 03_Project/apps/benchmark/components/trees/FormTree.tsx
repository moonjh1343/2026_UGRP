import { FormField } from '../widgets/FormField'
import type { FormPayload } from '@/lib/data'

/**
 * 폼형 트리. **지시어 없음** — 두 그래프 공용.
 *
 * DOM은 작지만 필드마다 검증기가 붙어 하이드레이션 대상이 많다.
 * Islands가 가장 잘 맞는 유형이다 — 섹션 제목·설명은 서버에 남고
 * 입력 필드만 섬이 된다.
 */
export function FormTree({ data }: { data: FormPayload }) {
  return (
    <form className="form" data-route={data.routeKey} onSubmit={undefined} noValidate>
      <h1>{data.title}</h1>

      {data.sections.map((s) => (
        <fieldset key={s.id} id={s.id}>
          <legend>{s.heading}</legend>
          {s.fields.map((f) => (
            <FormField key={f.id} field={f} />
          ))}
        </fieldset>
      ))}
    </form>
  )
}
