// stub-for: ui/LocationPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Location tab is ported (see docs/PORTING.md). */
export const locationView: ToolView = {
  id: 'location',
  title: 'Location',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Location is not ported yet.'))
  },
}
