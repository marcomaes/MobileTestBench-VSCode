// stub-for: ui/LogPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Log tab is ported (see docs/PORTING.md). */
export const logsHost: ToolHost = {
  id: 'logs',
  title: 'Log',
  async handle(method) {
    throw new Error(`Log: ${method} is not ported yet`)
  },
}
