// ported-from: ui/UrlLauncherPanel.kt
// Webview half of the Open URL tab: a field with the history as suggestions, Open and Clear history.
import { UrlLauncher } from '../../core/links/urlLauncher'
import type { ToolApi, ToolView } from '../toolApi'
import { button, h, injectToolStyles, input, messageLine, row } from '../ui'

export const openUrlView: ToolView = {
  id: 'openUrl',
  title: 'Open URL',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    let busy = false
    const field = input('', { placeholder: 'https://example.com or myapp://path', size: 60, list: 'mtb-url-history' })
    const datalist = h('datalist', { id: 'mtb-url-history' })
    const status = messageLine()
    const open = button('Open', () => void openUrl())
    const clear = button('Clear history', async () => {
      fillHistory(await api.request<string[]>('clearHistory'))
      status.set('History cleared')
    })

    function fillHistory(list: string[]): void {
      datalist.replaceChildren(...list.map((u) => h('option', { value: u })))
      clear.disabled = list.length === 0
    }

    function updateButtons(): void {
      open.disabled = !api.device || busy
    }

    async function openUrl(): Promise<void> {
      if (!api.device || busy) return
      const v = UrlLauncher.validate(field.value)
      if (v.type === 'Invalid') {
        status.error(v.reason)
        return
      }
      busy = true
      updateButtons()
      status.set(`Opening ${v.url}...`)
      try {
        const r = await api.request<{ url: string; history: string[] }>('open', { url: v.url })
        fillHistory(r.history)
        field.value = r.url
        status.set(`Opened ${r.url} on ${api.device?.name ?? 'the device'}`)
      } catch (e) {
        status.error((e as Error).message)
      }
      busy = false
      updateButtons()
    }

    // Enter in the field opens (choosing a history entry only fills the field).
    field.addEventListener('keydown', (e) => e.key === 'Enter' && void openUrl())
    root.append(row('URL or deep link:', field, datalist, open, clear), status)
    fillHistory([])
    void api.request<string[]>('history').then(fillHistory, () => undefined)
    status.set(api.device ? '' : 'Not connected')
    updateButtons()
  },
}
