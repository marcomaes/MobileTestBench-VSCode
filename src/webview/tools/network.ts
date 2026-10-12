// ported-from: ui/NetworkPanel.kt
import { button, h, row, select } from '../ui'
import type { ToolApi, ToolView } from '../toolApi'
import type { DeviceInfoDto } from '../../protocol'
import type { NetworkViewDto, StatusDto, WriteResult } from '../../extension/tools/network'

const IOS_NOTE =
  "iOS simulators share the Mac's network, so conditions cannot be changed per simulator here " +
  '(simctl status_bar only changes the icons in the status bar, it does not throttle or cut anything). ' +
  'To slow down or cut the network, use the Network Link Conditioner on the Mac (Additional Tools for Xcode, then its preference pane), ' +
  'or route the simulator through a proxy. Network Link Conditioner affects all traffic of the Mac, not only the simulator.'

let api: ToolApi | undefined
let device: DeviceInfoDto | undefined
let visible = false
let busy = false
let updating = false
let state: NetworkViewDto | undefined
/** Bumped for every read, write and device change: a result of an older run is dropped. */
let gen = 0
/** The preset the user picked last, so full / 5g and gprs / umts (identical numbers) keep the chosen name when read back. */
let pickedSpeed: string | undefined
let pickedDelay: string | undefined

let airplane: HTMLInputElement
let wifi: HTMLInputElement
let data: HTMLInputElement
let speed: HTMLSelectElement
let delay: HTMLSelectElement
let reset: HTMLButtonElement
let refreshButton: HTMLButtonElement
let iosNote: HTMLElement
let androidRows: HTMLElement[] = []
const st: Record<string, HTMLElement> = {}
let general: HTMLElement
let speedChoices: Array<{ value: string; label: string }> = []
let delayChoices: Array<{ value: string; label: string }> = []

const isAndroid = (d: DeviceInfoDto | undefined): boolean => d?.platform === 'ANDROID'
const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setStatus(el: HTMLElement, text: string, error = false): void {
  el.textContent = text.trim() === '' ? ' ' : text
  el.className = error ? 'mtb-msg err' : 'mtb-msg'
}
const showStatus = (el: HTMLElement, s: StatusDto): void => setStatus(el, s.text, s.error)

function fillChoices(el: HTMLSelectElement, choices: Array<{ value: string; label: string }>, selected: string | undefined): void {
  el.replaceChildren(...choices.map((c) => h('option', { value: c.value }, c.label)))
  if (selected === undefined) {
    el.append(h('option', { value: '' }, '(custom)'))
    el.value = ''
  } else el.value = selected
}

function updateEnabled(): void {
  const ok = isAndroid(device) && !busy && state !== undefined
  airplane.disabled = !(ok && state!.state.airplane !== undefined)
  wifi.disabled = !(ok && state!.state.wifi !== undefined)
  data.disabled = !(ok && state!.state.mobileData !== undefined)
  speed.disabled = !(ok && state!.hasEmulator)
  delay.disabled = !(ok && state!.hasEmulator)
  reset.disabled = !ok
  refreshButton.disabled = !(isAndroid(device) && !busy)
}

/** Sets what the connected device kind offers, before anything is read. */
function configure(): void {
  if (!api) return
  const d = device
  updating = true
  airplane.checked = wifi.checked = data.checked = false
  speed.replaceChildren()
  delay.replaceChildren()
  pickedSpeed = undefined
  pickedDelay = undefined
  updating = false
  for (const k of ['connection', 'airplane', 'wifi', 'data', 'speed', 'delay', 'changed']) setStatus(st[k], ' ')
  const android = isAndroid(d)
  iosNote.style.display = d !== undefined && !android ? '' : 'none'
  iosNote.textContent = d !== undefined && !android ? IOS_NOTE : ' '
  for (const r of androidRows) r.style.display = android || d === undefined ? '' : 'none'
  setStatus(general, d === undefined ? 'Not connected' : ' ')
  updateEnabled()
}

/** Shows what the device reported: the controls follow it, the status lines give the detail or the read error. */
function showState(v: NetworkViewDto): void {
  state = v
  updating = true
  airplane.checked = v.state.airplane === true
  wifi.checked = v.state.wifi === true
  data.checked = v.state.mobileData === true
  if (v.hasEmulator) {
    fillChoices(speed, speedChoices, v.speed)
    fillChoices(delay, delayChoices, v.delay)
  }
  updating = false
  showStatus(st.airplane, v.status.airplane)
  showStatus(st.wifi, v.status.wifi)
  showStatus(st.data, v.status.data)
  showStatus(st.speed, v.status.speed)
  showStatus(st.delay, v.status.delay)
  showStatus(st.connection, v.status.connection)
  showStatus(st.changed, v.status.changed)
  updateEnabled()
}

const readState = (): Promise<NetworkViewDto> => api!.request<NetworkViewDto>('read', { pickedSpeed, pickedDelay })

function refresh(): void {
  if (!api || !device || !isAndroid(device)) return
  const my = ++gen
  busy = true
  setStatus(general, 'Reading...')
  updateEnabled()
  readState().then(
    (v) => {
      if (my !== gen) return
      busy = false
      setStatus(general, ' ')
      showState(v)
    },
    (e) => {
      if (my !== gen) return
      busy = false
      state = undefined
      setStatus(general, failureText(e), true)
      updateEnabled()
    },
  )
}

/**
 * Runs the write (the host returns the first error or none), then reads the device back every second for up to [settleSeconds]
 * until [settled] holds, showing each reading. Controls stay disabled meanwhile. An error goes to [target].
 */
async function apply(
  target: HTMLElement,
  settleSeconds: number,
  settled: (s: NetworkViewDto['state']) => boolean,
  method: 'write' | 'reset',
  params?: unknown,
): Promise<void> {
  if (!api || !device || !state || busy) return
  const my = ++gen
  busy = true
  updateEnabled()
  setStatus(target, 'Applying...')
  let failure: string | undefined
  try {
    failure = (await api.request<WriteResult>(method, params)).failure
  } catch (e) {
    failure = failureText(e)
  }
  let last: NetworkViewDto | undefined
  let readError: string | undefined
  let attempt = 0
  while (attempt < settleSeconds || attempt === 0) {
    let shown: NetworkViewDto | undefined
    try {
      shown = await readState()
      last = shown
      readError = undefined
    } catch (e) {
      readError = failureText(e)
    }
    const done = failure !== undefined || (shown !== undefined && settled(shown.state)) || attempt + 1 >= settleSeconds
    if (my !== gen) return
    if (shown) showState(shown)
    if (!done) {
      setStatus(target, 'Reconnecting...')
      setStatus(general, 'Waiting for the device to settle...')
    }
    if (done) break
    await sleep(1000)
    if (my !== gen) return
    attempt++
  }
  busy = false
  setStatus(general, ' ')
  if (failure !== undefined) setStatus(target, failure, true)
  else if (last === undefined) setStatus(general, `Applied, but reading the device back failed: ${readError}`, true)
  updateEnabled()
}

export const networkView: ToolView = {
  id: 'network',
  title: 'Network',

  mount(root, a) {
    api = a
    device = a.device
    const sw = (label: string, onchange: () => void): { box: HTMLInputElement; el: HTMLLabelElement } => {
      const box = h('input', { type: 'checkbox' })
      box.addEventListener('change', () => {
        if (!updating) onchange()
      })
      return { box, el: h('label', { class: 'mtb-check' }, box, label) }
    }
    const a1 = sw('Airplane mode', () => {
      const on = airplane.checked
      void apply(st.airplane, 15, (s) => s.airplane === on && (on || s.online === true || s.wifi === true), 'write', { changes: [{ key: 'AIRPLANE', on }] })
    })
    const a2 = sw('Wi-Fi', () => {
      const on = wifi.checked
      void apply(st.wifi, 8, (s) => s.wifi === on, 'write', { changes: [{ key: 'WIFI', on }] })
    })
    const a3 = sw('Mobile data', () => {
      const on = data.checked
      void apply(st.data, 4, (s) => s.mobileData === on, 'write', { changes: [{ key: 'DATA', on }] })
    })
    airplane = a1.box
    wifi = a2.box
    data = a3.box
    speed = select([])
    delay = select([])
    speed.addEventListener('change', () => {
      if (updating || speed.value === '') return
      pickedSpeed = speed.value
      void apply(st.speed, 1, () => true, 'write', { changes: [{ key: 'SPEED', arg: speedArg(speed.value) }] })
    })
    delay.addEventListener('change', () => {
      if (updating || delay.value === '') return
      pickedDelay = delay.value
      void apply(st.delay, 1, () => true, 'write', { changes: [{ key: 'DELAY', arg: delayArg(delay.value) }] })
    })
    reset = button('Reset to normal', () => {
      void apply(general, 15, (s) => s.airplane === false || s.online === true, 'reset')
      pickedSpeed = undefined
      pickedDelay = undefined
    })
    refreshButton = button('Refresh', refresh)
    general = h('span', { class: 'mtb-msg' }, ' ')
    const statusLine = (key: string): HTMLElement => (st[key] = h('span', { class: 'mtb-msg' }, ' '))
    iosNote = h('div', { class: 'mtb-muted' }, ' ')
    const line = (label: string, control: HTMLElement, key: string): HTMLElement => row(h('span', { style: 'min-width:110px' }, label), control, statusLine(key))
    const connection = h('div', { class: 'mtb-msg', style: 'margin-top:6px' }, ' ')
    const changed = h('div', { class: 'mtb-msg' }, ' ')
    st.connection = connection
    st.changed = changed
    const rows = [
      line('Connectivity:', a1.el, 'airplane'),
      line('', a2.el, 'wifi'),
      line('', a3.el, 'data'),
      line('Emulator speed:', speed, 'speed'),
      line('Emulator latency:', delay, 'delay'),
      row(h('span', { style: 'min-width:110px' }, ''), reset, refreshButton, general),
      connection,
      changed,
      h(
        'div',
        { class: 'mtb-muted', style: 'margin-top:8px' },
        'Wi-Fi off alone or mobile data off alone stays online (the other one takes over); only airplane mode, or both off, goes offline. ' +
          'Turning airplane mode off takes several seconds to reconnect. Speed and latency are set through the emulator console and stay ' +
          'on the running emulator until you change them or press Reset to normal, which restores what this tab changed. ' +
          "Whether the throttling really slows an app's traffic is not verified here: the tab only checks what the console reports.",
      ),
    ]
    androidRows = rows
    root.append(iosNote, ...rows)
    void a.request<{ speeds: Array<{ value: string; label: string }>; delays: Array<{ value: string; label: string }> }>('presets').then((p) => {
      speedChoices = p.speeds
      delayChoices = p.delays
    })
    configure()
  },

  deviceChanged(d) {
    device = d
    gen++
    busy = false
    state = undefined
    configure()
    if (d && visible) refresh()
  },

  shown() {
    visible = true
    if (device && !busy) refresh()
  },

  hidden() {
    visible = false
  },
}

// Console arguments of the presets (SpeedPreset / DelayPreset in core/network/network.ts; the webview cannot import core).
const SPEED_ARGS: Record<string, string> = { FULL: 'full', G5: '5g', EVDO: 'evdo', LTE: 'lte', HSDPA: 'hsdpa', UMTS: 'umts', EDGE: 'edge', GPRS: 'gprs', HSCSD: 'hscsd', GSM: 'gsm' }
const DELAY_ARGS: Record<string, string> = { NONE: 'none', GPRS: 'gprs', EDGE: 'edge', UMTS: 'umts' }
const speedArg = (preset: string): string => SPEED_ARGS[preset]
const delayArg = (preset: string): string => DELAY_ARGS[preset]
