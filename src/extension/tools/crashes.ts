// ported-from: ui/CrashesPanel.kt
// Host half of the Crashes tab: lists and fetches the reports through mobilecli, and saves one to a file.
import * as vscode from 'vscode'
import { Crashes, type CrashEntry } from '../../core/crashes/crashes'
import type { ToolHost } from './toolHost'

export const crashesHost: ToolHost = {
  id: 'crashes',
  title: 'Crashes',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'list': {
        const entries = Crashes.parseList(await ctx.services.mobilecliData(ctx.device, Crashes.LIST_ARGS))
        return { entries, note: Crashes.listNote(ctx.device) ?? '' }
      }
      case 'get': {
        // iOS reports are about 200 KB, so only on selection.
        const content = Crashes.parseReport(await ctx.services.mobilecliData(ctx.device, Crashes.getArgs(String(p.id)), 60_000))
        if (content === undefined) throw new Error('The report is empty')
        return { content, summary: Crashes.summary(ctx.device.platform, content) ?? '' }
      }
      case 'save': {
        const entry = p.entry as CrashEntry
        const name = Crashes.fileName(entry, ctx.device.platform)
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri
        const target = await vscode.window.showSaveDialog({
          defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
          filters: { 'Crash reports': ['txt', 'ips'] },
          title: 'Save Crash Report',
        })
        if (!target) return ''
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(String(p.content), 'utf8'))
          return `Saved to ${target.fsPath}`
        } catch (e) {
          return `Could not save the report: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      default:
        throw new Error(`Crashes: unknown method ${method}`)
    }
  },
}
