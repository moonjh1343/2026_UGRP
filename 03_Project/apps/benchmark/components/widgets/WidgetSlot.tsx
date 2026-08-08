import type { WidgetSpec } from '@/lib/data'
import { NoteWidget } from './NoteWidget'
import { ShareButton } from './ShareButton'
import { TocToggle } from './TocToggle'

/**
 * 지시어 없음 — 디스패처 자체는 두 그래프 공용이고, 실제 위젯만 클라이언트다.
 * Islands 모드에서 이 디스패처는 서버에서 실행되고 위젯만 섬이 된다.
 */
export function WidgetSlot({
  widget,
  toc,
}: {
  widget: WidgetSpec
  toc: { id: string; label: string }[]
}) {
  switch (widget.kind) {
    case 'toc':
      return <TocToggle items={toc} label={widget.label} />
    case 'share':
      return <ShareButton label={widget.label} />
    case 'note':
      return <NoteWidget label={widget.label} />
  }
}
