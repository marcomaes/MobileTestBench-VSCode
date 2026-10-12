// stub-for: ui/LogPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Log tab is ported (see docs/PORTING.md). */
export const logsView: ToolView = {
  id: 'logs',
  title: 'Log',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Log is not ported yet.'))
  },
}
