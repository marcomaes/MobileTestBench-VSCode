// stub-for: ui/BatteryPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Battery tab is ported (see docs/PORTING.md). */
export const batteryHost: ToolHost = {
  id: 'battery',
  title: 'Battery',
  async handle(method) {
    throw new Error(`Battery: ${method} is not ported yet`)
  },
}
