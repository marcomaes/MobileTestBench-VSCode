// stub-for: ui/NotificationsPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Notifications tab is ported (see docs/PORTING.md). */
export const notificationsHost: ToolHost = {
  id: 'notifications',
  title: 'Notifications',
  async handle(method) {
    throw new Error(`Notifications: ${method} is not ported yet`)
  },
}
