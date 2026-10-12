// stub-for: ui/CrashesPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Crashes tab is ported (see docs/PORTING.md). */
export const crashesHost: ToolHost = {
  id: 'crashes',
  title: 'Crashes',
  async handle(method) {
    throw new Error(`Crashes: ${method} is not ported yet`)
  },
}
