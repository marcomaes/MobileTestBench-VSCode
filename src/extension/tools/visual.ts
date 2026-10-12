// stub-for: ui/VisualPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Visual tab is ported (see docs/PORTING.md). */
export const visualHost: ToolHost = {
  id: 'visual',
  title: 'Visual',
  async handle(method) {
    throw new Error(`Visual: ${method} is not ported yet`)
  },
}
