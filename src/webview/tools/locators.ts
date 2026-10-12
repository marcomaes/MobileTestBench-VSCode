// stub-for: ui/InspectorPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Locators tab is ported (see docs/PORTING.md). */
export const locatorsView: ToolView = {
  id: 'locators',
  title: 'Locators',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Locators is not ported yet.'))
  },
}
