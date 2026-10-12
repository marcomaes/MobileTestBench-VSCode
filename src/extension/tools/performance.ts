// stub-for: ui/PerformancePanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Performance tab is ported (see docs/PORTING.md). */
export const performanceHost: ToolHost = {
  id: 'performance',
  title: 'Performance',
  async handle(method) {
    throw new Error(`Performance: ${method} is not ported yet`)
  },
}
