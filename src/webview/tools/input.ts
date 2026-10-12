// ported-from: ui/InputPanel.kt
import { button, h, row } from '../ui'
import type { ToolApi, ToolView } from '../toolApi'
import type { DeviceInfoDto } from '../../protocol'
import type { ActionResult, InputConfigDto } from '../../extension/tools/input'

let api: ToolApi | undefined
let device: DeviceInfoDto | undefined
/** Bumped on a device change: a result of an action started for another device is dropped. */
let gen = 0

let hardware: HTMLElement
let keyboard: HTMLElement
let clip: HTMLElement
let hardwareNote: HTMLElement
let clipboardNote: HTMLElement
let status: HTMLElement
let clipboardText: HTMLTextAreaElement
let wake: HTMLButtonElement
let hideKeyboard: HTMLButtonElement
let clipboardButtons: HTMLButtonElement[] = []
let buttonEls: HTMLButtonElement[] = []
let keyEls: HTMLButtonElement[] = []

function setStatus(text: string, error: boolean): void {
  status.textContent = text.trim() === '' ? ' ' : text
  status.className = error ? 'mtb-msg err' : 'mtb-msg'
}

const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Runs [method] on the host and shows its exact result; with a read-back it is appended. */
function act(method: string, params?: unknown): void {
  if (!api || !device) return
  const my = gen
  setStatus('Working...', false)
  api.request<ActionResult>(method, params).then(
    (r) => {
      if (my === gen) setStatus(r.message + (r.readBack ? `. Device now: ${r.readBack}` : ''), false)
    },
    (e) => {
      if (my === gen) setStatus(failureText(e), true)
    },
  )
}

function getClipboard(): void {
  if (!api || !device) return
  const my = gen
  setStatus('Reading the clipboard...', false)
  api.request<{ text: string }>('clipboardGet').then(
    ({ text }) => {
      if (my !== gen) return
      clipboardText.value = text
      setStatus(text.length === 0 ? 'The device clipboard is empty' : `Read ${text.length} characters from the device clipboard`, false)
    },
    (e) => {
      if (my === gen) setStatus(failureText(e), true)
    },
  )
}

function applyConfig(c: InputConfigDto): void {
  hardwareNote.textContent = c.hardwareNote || ' '
  clipboardNote.textContent = c.clipboardNote || ' '
  c.buttons.forEach((b, i) => {
    buttonEls[i].disabled = !b.enabled
    buttonEls[i].title = b.tooltip
  })
  c.keys.forEach((k, i) => {
    keyEls[i].disabled = !k.enabled
    keyEls[i].title = k.tooltip
  })
  wake.disabled = !c.wakeEnabled
  wake.title = 'Android: sends WAKEUP (the Power button only toggles)'
  hideKeyboard.disabled = !c.hideKeyboardEnabled
  hideKeyboard.title = c.hideKeyboardTooltip
  for (const b of clipboardButtons) b.disabled = !c.clipboardEnabled
}

/** Enables what the connected device offers; with no device everything is disabled. */
function configure(): void {
  if (!api) return
  const my = gen
  if (!device) {
    for (const b of [...buttonEls, ...keyEls, wake, hideKeyboard, ...clipboardButtons]) b.disabled = true
    hardwareNote.textContent = ' '
    clipboardNote.textContent = ' '
    setStatus('Not connected', false)
    return
  }
  setStatus(' ', false)
  api.request<InputConfigDto>('configure').then(
    (c) => {
      if (my === gen) applyConfig(c)
    },
    (e) => {
      if (my === gen) setStatus(failureText(e), true)
    },
  )
}

/** Hardware buttons and special keys of the connected device; the lists mirror HardwareButton / InputKey in core/input/input.ts. */
const BUTTONS: Array<[string, string]> = [
  ['VOLUME_UP', 'Volume up'],
  ['VOLUME_DOWN', 'Volume down'],
  ['HOME', 'Home'],
  ['POWER', 'Power / Lock'],
  ['BACK', 'Back'],
  ['APP_SWITCH', 'App switch'],
  ['ASSISTANT', 'Assistant'],
  ['SHAKE', 'Shake'],
]
const KEYS: Array<[string, string]> = [
  ['TAB', 'Tab'],
  ['ESCAPE', 'Esc'],
  ['ENTER', 'Enter'],
  ['BACKSPACE', 'Backspace'],
  ['DELETE', 'Delete'],
  ['UP', 'Up'],
  ['DOWN', 'Down'],
  ['LEFT', 'Left'],
  ['RIGHT', 'Right'],
]

const group = (name: string, ...children: HTMLElement[]): HTMLElement =>
  h('fieldset', { style: 'margin:4px 0;border:1px solid var(--vscode-panel-border)' }, h('legend', {}, name), ...children)

export const inputView: ToolView = {
  id: 'input',
  title: 'Input',

  mount(root, a) {
    api = a
    device = a.device
    buttonEls = BUTTONS.map(([name, label]) => button(label, () => act('press', { button: name })))
    wake = button('Wake', () => act('wake'), { title: 'Android: sends WAKEUP (the Power button only toggles)' })
    keyEls = KEYS.map(([name, label]) => button(label, () => act('pressKey', { key: name })))
    hideKeyboard = button('Hide keyboard', () => act('hideKeyboard'))
    clipboardText = h('textarea', { class: 'mtb-input', rows: 4, style: 'width:100%;box-sizing:border-box' })
    const get = button('Get from device', getClipboard)
    const set = button('Set on device', () => act('clipboardSet', { text: clipboardText.value }))
    const paste = button('Set and paste', () => act('setAndPaste', { text: clipboardText.value }), {
      title: 'Sets the clipboard, then pastes into the focused field (ctrl+v on Android, cmd+v on iOS)',
    })
    const clear = button('Clear', () => {
      clipboardText.value = ''
      act('clipboardSet', { text: '' })
    })
    clipboardButtons = [get, set, paste, clear]
    hardwareNote = h('div', { class: 'mtb-muted' }, ' ')
    clipboardNote = h('div', { class: 'mtb-muted' }, ' ')
    status = h('div', { class: 'mtb-msg' }, ' ')
    hardware = group('Hardware buttons', row(...buttonEls, wake), hardwareNote)
    keyboard = group(
      'Keyboard',
      row(...keyEls, hideKeyboard),
      h('div', { class: 'mtb-muted' }, 'Tap a text field to show the keyboard. Hide keyboard sends Escape, never Back. Hiding the keyboard on iOS is not supported by the tools.'),
    )
    clip = group('Clipboard', clipboardText, row(...clipboardButtons), clipboardNote)
    root.append(hardware, keyboard, clip, status)
    configure()
    setStatus(device ? ' ' : 'Not connected', false)
  },

  deviceChanged(d) {
    device = d
    gen++
    configure()
  },
}
