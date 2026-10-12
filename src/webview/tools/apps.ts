// stub-for: ui/AppsPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Apps tab is ported (see docs/PORTING.md). */
export const appsView: ToolView = {
  id: 'apps',
  title: 'Apps',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Apps is not ported yet.'))
  },
}
