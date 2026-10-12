// stub-for: ui/BatteryPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Battery tab is ported (see docs/PORTING.md). */
export const batteryView: ToolView = {
  id: 'battery',
  title: 'Battery',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Battery is not ported yet.'))
  },
}
