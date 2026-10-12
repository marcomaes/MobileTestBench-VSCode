// stub-for: ui/DisplayPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Display tab is ported (see docs/PORTING.md). */
export const displayView: ToolView = {
  id: 'display',
  title: 'Display',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Display is not ported yet.'))
  },
}
