// ported-from: ui/RecorderPanel.kt
// Host half of the Recorder tab. The logic is in ../recorderController.ts (pure, tested); this file wires it to the viewer, the
// settings and VS Code (quick pick for the Assert menu, input boxes, the editor). One controller per device viewer.
import * as vscode from 'vscode'
import type { Check } from '../../core/recording/assertion'
import { ReplayOptions } from '../../core/recording/replayOptions'
import { ScrollUntilVisible } from '../../core/recording/scrollUntilVisible'
import { EditorInsert } from '../editorInsert'
import { RecorderController } from '../recorderController'
import type { ToolContext, ToolHost } from './toolHost'
import { viewerState } from './viewerState'

function controllerOf(ctx: ToolContext): RecorderController {
  return viewerState(ctx, 'recorder', () => {
    // The emit of a ToolContext is bound to this tool; the controller keeps the first one (the webview of this viewer).
    const emit = ctx.emit
    return new RecorderController({
      viewer: ctx.viewer,
      session: ctx.session,
      settings: () => {
        const s = ctx.settings()
        return { recorderOutput: s.recorderOutput, replayTimeoutSeconds: s.replayTimeoutSeconds, replayDelayMs: s.replayDelayMs }
      },
      saveOutput: (name) => void ctx.updateSetting('recorderOutput', name),
      emit: (view) => emit('state', view),
      async choose(title, options) {
        const items = options.map((check) => ({ label: check.label, check }))
        const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose what to check' })
        return pick?.check as Check | undefined
      },
      async askCount(proposed) {
        const text = await vscode.window.showInputBox({
          title: 'Count Assertion',
          prompt: 'Expected number of matching elements:',
          value: String(proposed),
          validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a number, 0 or more'),
        })
        return text === undefined ? undefined : Number(text.trim())
      },
      async askTimeout(currentSeconds) {
        const r = ReplayOptions.STEP_TIMEOUT_SECONDS
        const text = await vscode.window.showInputBox({
          title: 'Set Timeout',
          prompt: `Timeout in seconds for the selected wait and expect steps (${r.first} to ${r.last}). Leave empty to use the replay timeout from the settings.`,
          value: currentSeconds === undefined ? '' : String(currentSeconds),
          validateInput: (v) => (v.trim() === '' || ReplayOptions.parseStepSeconds(v) !== undefined ? undefined : `Enter whole seconds from ${r.first} to ${r.last}`),
        })
        if (text === undefined) return undefined
        return text.trim() === '' ? null : ReplayOptions.parseStepSeconds(text)
      },
      async askScroll(direction, maxSwipes) {
        const picked = await vscode.window.showQuickPick([...ScrollUntilVisible.DIRECTIONS], { title: 'Scroll Until Visible: swipe direction', placeHolder: direction })
        if (!picked) return undefined
        const limits = ScrollUntilVisible.LIMIT_RANGE
        const text = await vscode.window.showInputBox({
          title: 'Scroll Until Visible: max swipes',
          prompt: `${limits.first} to ${limits.last}`,
          value: String(maxSwipes),
          validateInput: (v) => (ScrollUntilVisible.parseLimit(v) !== undefined ? undefined : `Enter a whole number from ${limits.first} to ${limits.last}`),
        })
        const limit = text === undefined ? undefined : ScrollUntilVisible.parseLimit(text)
        return limit === undefined ? undefined : { direction: picked, maxSwipes: limit }
      },
      notify: (message) => void vscode.window.showWarningMessage(message),
    })
  })
}

const rowsOf = (p: Record<string, unknown>): number[] => (Array.isArray(p.rows) ? (p.rows as unknown[]).map(Number) : [])

export const recorderHost: ToolHost = {
  id: 'recorder',
  title: 'Recorder',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    const c = controllerOf(ctx)
    switch (method) {
      case 'state':
        return c.view()
      case 'record':
        c.setRecording(p.on === true)
        return undefined
      case 'assert':
        c.setArmed(p.on === true)
        return undefined
      case 'pick':
        await c.pick(Number(p.x), Number(p.y))
        return undefined
      case 'clear':
        c.clear()
        return undefined
      case 'output':
        c.setOutput(String(p.name))
        return undefined
      case 'code':
        return c.code()
      case 'insert': {
        const problem = await EditorInsert.insertAtCaret(c.code())
        return problem ?? 'Inserted'
      }
      case 'replay': {
        const range = p.range as { first: number; last: number } | undefined
        // Not awaited: progress comes as state events, the request ends at once.
        void c.replay(range)
        return undefined
      }
      case 'replaySelected':
        void c.replay(ReplayOptions.selectedRange(rowsOf(p), c.view().rows.length))
        return undefined
      case 'replayFrom':
        void c.replay(ReplayOptions.fromSelected(rowsOf(p), c.view().rows.length))
        return undefined
      case 'stopReplay':
        c.stopReplay()
        return undefined
      case 'scroll':
        c.scrollUntilVisible(rowsOf(p))
        return undefined
      case 'scrollOptions':
        await c.askScroll(rowsOf(p))
        return undefined
      case 'timeout':
        await c.askTimeout(rowsOf(p))
        return undefined
      case 'stop':
        // The session ended: recording stops (Kotlin disposes the recording with the session).
        if (c.isRecording) c.setRecording(false)
        return undefined
      default:
        throw new Error(`Recorder: unknown method ${method}`)
    }
  },

  dispose(ctx) {
    controllerOf(ctx).dispose()
  },
}
