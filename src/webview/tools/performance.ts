// stub-for: ui/PerformancePanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Performance tab is ported (see docs/PORTING.md). */
export const performanceView: ToolView = {
  id: 'performance',
  title: 'Performance',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Performance is not ported yet.'))
  },
}
