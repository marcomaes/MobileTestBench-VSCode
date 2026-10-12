// stub-for: ui/RecorderPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Recorder tab is ported (see docs/PORTING.md). */
export const recorderView: ToolView = {
  id: 'recorder',
  title: 'Recorder',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Recorder is not ported yet.'))
  },
}
