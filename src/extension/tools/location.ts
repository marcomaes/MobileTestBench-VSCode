// stub-for: ui/LocationPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Location tab is ported (see docs/PORTING.md). */
export const locationHost: ToolHost = {
  id: 'location',
  title: 'Location',
  async handle(method) {
    throw new Error(`Location: ${method} is not ported yet`)
  },
}
