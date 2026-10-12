// stub-for: ui/NotificationsPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Notifications tab is ported (see docs/PORTING.md). */
export const notificationsView: ToolView = {
  id: 'notifications',
  title: 'Notifications',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Notifications is not ported yet.'))
  },
}
