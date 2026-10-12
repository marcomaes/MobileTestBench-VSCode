// ported-from: settings/JBViewMobileSettings.kt
import * as vscode from 'vscode'
import { defaultSettings, type Settings } from '../settings'

const SECTION = 'mobileTestBench'

/** Reads the settings from VS Code's configuration, falling back to the defaults in src/settings.ts. */
export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const out = { ...defaultSettings } as Record<string, unknown>
  for (const key of Object.keys(defaultSettings)) out[key] = cfg.get(key, (defaultSettings as unknown as Record<string, unknown>)[key])
  return out as unknown as Settings
}

export async function writeSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global)
}
