// stub-for: ui/InputPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Input tab is ported (see docs/PORTING.md). */
export const inputView: ToolView = {
  id: 'input',
  title: 'Input',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Input is not ported yet.'))
  },
}
