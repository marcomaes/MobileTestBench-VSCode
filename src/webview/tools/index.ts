// ported-from: ui/DeviceToolsPanel.kt
// The single list of Device Tools tabs (webview half). Same ids, same order as src/extension/tools/index.ts.
import type { ToolView } from '../toolApi'
import { locatorsView } from './locators'
import { recorderView } from './recorder'
import { logsView } from './logs'
import { appsView } from './apps'
import { openUrlView } from './openUrl'
import { crashesView } from './crashes'
import { locationView } from './location'
import { displayView } from './display'
import { inputView } from './input'
import { networkView } from './network'
import { batteryView } from './battery'
import { biometricsView } from './biometrics'
import { webviewView } from './webview'
import { filesView } from './files'
import { performanceView } from './performance'
import { visualView } from './visual'
import { notificationsView } from './notifications'

export const toolViews: ToolView[] = [
  locatorsView,
  recorderView,
  logsView,
  appsView,
  openUrlView,
  crashesView,
  locationView,
  displayView,
  inputView,
  networkView,
  batteryView,
  biometricsView,
  webviewView,
  filesView,
  performanceView,
  visualView,
  notificationsView,
]
