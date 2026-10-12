// stub-for: ui/NetworkPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Network tab is ported (see docs/PORTING.md). */
export const networkHost: ToolHost = {
  id: 'network',
  title: 'Network',
  async handle(method) {
    throw new Error(`Network: ${method} is not ported yet`)
  },
}
