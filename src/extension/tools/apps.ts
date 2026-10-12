// stub-for: ui/AppsPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Apps tab is ported (see docs/PORTING.md). */
export const appsHost: ToolHost = {
  id: 'apps',
  title: 'Apps',
  async handle(method) {
    throw new Error(`Apps: ${method} is not ported yet`)
  },
}
