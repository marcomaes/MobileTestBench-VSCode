// stub-for: ui/WebViewPanel.kt
import { h } from '../ui'
import type { ToolView } from '../toolApi'

/** Placeholder: replaced when the WebView tab is ported (see docs/PORTING.md). */
export const webviewView: ToolView = {
  id: 'webview',
  title: 'WebView',
  mount(root) {
    root.append(h('p', { class: 'mtb-muted' }, 'WebView is not ported yet.'))
  },
}
