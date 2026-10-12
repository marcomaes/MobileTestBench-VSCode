// stub-for: ui/BiometricsPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the Biometrics tab is ported (see docs/PORTING.md). */
export const biometricsView: ToolView = {
  id: 'biometrics',
  title: 'Biometrics',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'Biometrics is not ported yet.'))
  },
}
