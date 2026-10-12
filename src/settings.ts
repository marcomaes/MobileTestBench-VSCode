// ported-from: settings/JBViewMobileSettings.kt
// Defaults must match package.json "contributes.configuration" (checked by test/settings.test.ts).

/** The persistent settings. Names match the Kotlin MobileTestBenchSettings state where one exists. */
export interface Settings {
  adbPath: string
  useEmulatorGrpc: boolean
  screenshotIntervalMs: number
  wdaUrl: string
  mjpegUrl: string
  longPressMs: number
  elementFilter: string
  locatorLanguage: string
  contrastHints: boolean
  recorderOutput: string
  replayTimeoutSeconds: number
  replayDelayMs: number
  hideSystemApps: boolean
  reconnectAutomatically: boolean
  reconnectToLastDevice: boolean
  showGrid: boolean
  visualTolerance: number
  filesDownloadFolder: string
  perfWindowSeconds: number
  perfStartRuns: number
  perfStartKind: string
}

export const defaultSettings: Settings = {
  adbPath: '',
  useEmulatorGrpc: true,
  screenshotIntervalMs: 250,
  wdaUrl: 'http://localhost:8100',
  mjpegUrl: 'http://localhost:9100',
  longPressMs: 700,
  elementFilter: '',
  locatorLanguage: 'AS_SHOWN',
  contrastHints: true,
  recorderOutput: 'MOBILEWRIGHT',
  replayTimeoutSeconds: 10,
  replayDelayMs: 0,
  hideSystemApps: true,
  reconnectAutomatically: true,
  reconnectToLastDevice: false,
  showGrid: false,
  visualTolerance: 8,
  filesDownloadFolder: '',
  perfWindowSeconds: 60,
  perfStartRuns: 5,
  perfStartKind: 'COLD',
}
