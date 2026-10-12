// stub-for: ui/UrlLauncherPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Open URL tab is ported (see docs/PORTING.md). */
export const openUrlHost: ToolHost = {
  id: 'openUrl',
  title: 'Open URL',
  async handle(method) {
    throw new Error(`Open URL: ${method} is not ported yet`)
  },
}
