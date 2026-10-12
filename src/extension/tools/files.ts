// stub-for: ui/FilesPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Files tab is ported (see docs/PORTING.md). */
export const filesHost: ToolHost = {
  id: 'files',
  title: 'Files',
  async handle(method) {
    throw new Error(`Files: ${method} is not ported yet`)
  },
}
