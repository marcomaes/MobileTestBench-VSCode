// stub-for: ui/VisualPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Visual tab is ported (see docs/PORTING.md). */
export const visualView: ToolView = {
  id: 'visual',
  title: 'Visual',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Visual is not ported yet.'))
  },
}
