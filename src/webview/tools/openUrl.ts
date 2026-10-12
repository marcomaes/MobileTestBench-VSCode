// stub-for: ui/UrlLauncherPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Open URL tab is ported (see docs/PORTING.md). */
export const openUrlView: ToolView = {
  id: 'openUrl',
  title: 'Open URL',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Open URL is not ported yet.'))
  },
}
