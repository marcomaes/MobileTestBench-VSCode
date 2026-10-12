// stub-for: ui/InspectorPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Locators tab is ported (see docs/PORTING.md). */
export const locatorsHost: ToolHost = {
  id: 'locators',
  title: 'Locators',
  async handle(method) {
    throw new Error(`Locators: ${method} is not ported yet`)
  },
}
