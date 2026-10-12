// stub-for: ui/FilesPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Files tab is ported (see docs/PORTING.md). */
export const filesView: ToolView = {
  id: 'files',
  title: 'Files',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Files is not ported yet.'))
  },
}
