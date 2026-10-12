// stub-for: ui/RecorderPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Recorder tab is ported (see docs/PORTING.md). */
export const recorderHost: ToolHost = {
  id: 'recorder',
  title: 'Recorder',
  async handle(method) {
    throw new Error(`Recorder: ${method} is not ported yet`)
  },
}
