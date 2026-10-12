// stub-for: ui/BiometricsPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the Biometrics tab is ported (see docs/PORTING.md). */
export const biometricsHost: ToolHost = {
  id: 'biometrics',
  title: 'Biometrics',
  async handle(method) {
    throw new Error(`Biometrics: ${method} is not ported yet`)
  },
}
