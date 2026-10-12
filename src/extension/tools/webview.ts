// stub-for: ui/WebViewPanel.kt
import type { ToolHost } from './toolHost'

/** Placeholder: replaced when the WebView tab is ported (see docs/PORTING.md). */
export const webviewHost: ToolHost = {
  id: 'webview',
  title: 'WebView',
  async handle(method) {
    throw new Error(`WebView: ${method} is not ported yet`)
  },
}
