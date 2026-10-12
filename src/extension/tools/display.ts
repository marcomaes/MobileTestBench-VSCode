// stub-for: ui/DisplayPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Display tab is ported (see docs/PORTING.md). */
export const displayHost: ToolHost = {
  id: 'display',
  title: 'Display',
  async handle(method) {
    throw new Error(`Display: ${method} is not ported yet`)
  },
}
