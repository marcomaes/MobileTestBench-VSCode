// ported-from: ui/InputPanel.kt
// Host half of the Input tab: hardware buttons, special keys, soft keyboard hiding and the clipboard. Each action runs here and the
// webview shows its exact result or the tool's own error. Pure logic is in core/input.
import { HardwareButtons, InputActions, InputKeys, type HardwareButton, type InputKey } from '../../core/input/input'
import type { ToolContext, ToolHost } from './toolHost'

export interface InputConfigDto {
  connected: boolean
  buttons: Array<{ name: string; label: string; enabled: boolean; tooltip: string }>
  keys: Array<{ name: string; label: string; enabled: boolean; tooltip: string }>
  wakeEnabled: boolean
  hideKeyboardEnabled: boolean
  hideKeyboardTooltip: string
  clipboardEnabled: boolean
  hardwareNote: string
  clipboardNote: string
}

export interface ActionResult {
  message: string
  /** What the device reports after a button press (wakefulness, volume, lock state), when read. */
  readBack?: string
}

/** Enables what the connected device offers; a disabled control says why in its tooltip (Kotlin `configure`). */
function configure(ctx: ToolContext): InputConfigDto {
  const d = ctx.device
  const platform = d.platform
  const mobilecli = ctx.services.mobilecli() !== undefined
  const android = platform === 'ANDROID'
  const buttons = HardwareButtons.values.map((b) => {
    const on = HardwareButtons.supports(b, platform) && (android || mobilecli || (b === 'SHAKE' && d.kind === 'SIMULATOR'))
    const hint = HardwareButtons.hint(b, platform)
    const tooltip = !HardwareButtons.supports(b, platform) ? hint : !on ? 'Needs mobilecli (or a simulator for Shake)' : hint
    return { name: b, label: HardwareButtons.label(b), enabled: on, tooltip }
  })
  return {
    connected: true,
    buttons,
    keys: InputKeys.values.map((k) => ({
      name: k,
      label: InputKeys.label(k),
      enabled: android || mobilecli,
      tooltip: !android && !mobilecli ? 'Keys on iOS need mobilecli' : '',
    })),
    wakeEnabled: android,
    hideKeyboardEnabled: android,
    hideKeyboardTooltip: !android ? 'Not supported on iOS: the tools cannot hide its keyboard' : '',
    clipboardEnabled: mobilecli,
    hardwareNote: android
      ? 'Power toggles the screen. Volume presses show the result below: the first press may only show the panel.'
      : 'Lock toggles the simulator lock; wake it, then press Home to unlock (sometimes twice). The status shows the lock state.',
    clipboardNote: !mobilecli
      ? InputActions.CLIPBOARD_NEEDS_MOBILECLI
      : d.kind === 'EMULATOR'
        ? 'Android emulator clipboards are shared with this computer: Set on device also changes your clipboard here.'
        : platform === 'IOS'
          ? 'Paste on iOS shows an Allow Paste prompt on the device that you have to answer.'
          : '',
  }
}

/** Runs [work]; with [readStatus] the device read-back (wakefulness, volume, lock state) is appended. */
async function act(ctx: ToolContext, readStatus: boolean, work: (a: InputActions) => Promise<string>): Promise<ActionResult> {
  const actions = await ctx.services.input(ctx.device)
  const message = await work(actions)
  const readBack = readStatus ? await actions.status().catch(() => undefined) : undefined
  return { message, readBack }
}

export const inputHost: ToolHost = {
  id: 'input',
  title: 'Input',
  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'configure':
        return configure(ctx)
      case 'press':
        return act(ctx, true, (a) => a.press(p.button as HardwareButton))
      case 'wake':
        return act(ctx, true, (a) => a.wake())
      case 'pressKey':
        return act(ctx, false, (a) => a.pressKey(p.key as InputKey))
      case 'hideKeyboard':
        return act(ctx, false, (a) => a.hideKeyboard())
      case 'clipboardGet': {
        const text = await (await ctx.services.input(ctx.device)).clipboardGet()
        return { text }
      }
      case 'clipboardSet':
        return act(ctx, false, (a) => a.clipboardSet(String(p.text ?? '')))
      case 'setAndPaste':
        return act(ctx, false, (a) => a.setAndPaste(String(p.text ?? '')))
      default:
        throw new Error(`Input: unknown method ${method}`)
    }
  },
}
