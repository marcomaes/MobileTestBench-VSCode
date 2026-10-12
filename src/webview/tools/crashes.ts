// stub-for: ui/CrashesPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Crashes tab is ported (see docs/PORTING.md). */
export const crashesView: ToolView = {
  id: 'crashes',
  title: 'Crashes',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Crashes is not ported yet.'))
  },
}
