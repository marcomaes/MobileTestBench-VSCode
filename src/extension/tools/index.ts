// ported-from: ui/DeviceToolsPanel.kt
// The single list of Device Tools tabs (host half), like the `tabs` list in DeviceToolsPanel. Order is the tab order.
// A tool owns its two files (this folder and src/webview/tools); do not edit the list when porting one, only its files.
import type { ToolHost } from './toolHost'
import { locatorsHost } from './locators'
import { recorderHost } from './recorder'
import { logsHost } from './logs'
import { appsHost } from './apps'
import { openUrlHost } from './openUrl'
import { crashesHost } from './crashes'
import { locationHost } from './location'
import { displayHost } from './display'
import { inputHost } from './input'
import { networkHost } from './network'
import { batteryHost } from './battery'
import { biometricsHost } from './biometrics'
import { webviewHost } from './webview'
import { filesHost } from './files'
import { performanceHost } from './performance'
import { visualHost } from './visual'
import { notificationsHost } from './notifications'

export const toolHosts: ToolHost[] = [
  locatorsHost,
  recorderHost,
  logsHost,
  appsHost,
  openUrlHost,
  crashesHost,
  locationHost,
  displayHost,
  inputHost,
  networkHost,
  batteryHost,
  biometricsHost,
  webviewHost,
  filesHost,
  performanceHost,
  visualHost,
  notificationsHost,
]
