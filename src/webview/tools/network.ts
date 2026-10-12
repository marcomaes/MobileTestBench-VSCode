// stub-for: ui/NetworkPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Network tab is ported (see docs/PORTING.md). */
export const networkView: ToolView = {
  id: 'network',
  title: 'Network',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Network is not ported yet.'))
  },
}
