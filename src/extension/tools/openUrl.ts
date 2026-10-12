// ported-from: ui/UrlLauncherPanel.kt
// Host half of the Open URL tab. The history (Kotlin setting `urlHistory`) is kept in the extension's globalState.
import { UrlLauncher } from '../../core/links/urlLauncher'
import type { ToolHost } from './toolHost'

const HISTORY_KEY = 'mobileTestBench.urlHistory'

export const openUrlHost: ToolHost = {
  id: 'openUrl',
  title: 'Open URL',

  async handle(method, params, ctx) {
    const state = ctx.extensionContext.globalState
    const history = (): string[] => state.get<string[]>(HISTORY_KEY, [])
    switch (method) {
      case 'history':
        return history()
      case 'clearHistory':
        await state.update(HISTORY_KEY, [])
        return []
      case 'open': {
        const v = UrlLauncher.validate(String((params as { url?: unknown })?.url ?? ''))
        if (v.type === 'Invalid') throw new Error(v.reason)
        try {
          await ctx.services.mobilecliCall(ctx.device, UrlLauncher.args(v.url))
        } catch (e) {
          throw new Error(UrlLauncher.friendlyError(e instanceof Error ? e.message : String(e)))
        }
        const next = UrlLauncher.addToHistory(history(), v.url)
        await state.update(HISTORY_KEY, next)
        return { url: v.url, history: next }
      }
      default:
        throw new Error(`Open URL: unknown method ${method}`)
    }
  },
}
