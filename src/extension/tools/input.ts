// stub-for: ui/InputPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Input tab is ported (see docs/PORTING.md). */
export const inputHost: ToolHost = {
  id: 'input',
  title: 'Input',
  async handle(method) {
    throw new Error(`Input: ${method} is not ported yet`)
  },
}
