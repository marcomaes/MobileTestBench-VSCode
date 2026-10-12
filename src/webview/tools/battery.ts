// ported-from: ui/BatteryPanel.kt
import { button, h, row, select } from '../ui'
import type { ToolApi, ToolView } from '../toolApi'
import type { DeviceInfoDto } from '../../protocol'
import type { BatteryViewDto, BatteryWriteResult } from '../../extension/tools/battery'

const FOREGROUND = 'Foreground app'
const IOS_NOTE =
  'Battery simulation is not possible on iOS simulators: simctl has no command for the battery level or charging state ' +
  '(simctl status_bar --batteryLevel only changes the icon in the status bar, it does not change what apps read). ' +
  'Memory warnings have no simctl command either: use Simulator > Debug > Simulate Memory Warning. ' +
  'Use an Android emulator or device for the Battery and Memory controls here.'

let api: ToolApi | undefined
let device: DeviceInfoDto | undefined
let loaded = false
let visible = false
let busy = false
let updating = false
let trimBusy = false
/** Bumped for every read, write and device change: a result of an older run is dropped. */
let gen = 0

let level: HTMLInputElement
let levelText: HTMLElement
let status: HTMLSelectElement
let ac: HTMLInputElement
let usb: HTMLInputElement
let reset: HTMLButtonElement
let refreshButton: HTMLButtonElement
let general: HTMLElement
let note: HTMLElement
let iosNote: HTMLElement
let trimLevel: HTMLSelectElement
let trimApp: HTMLInputElement
let trimSend: HTMLButtonElement
let trimStatus: HTMLElement
let controls: HTMLElement[] = []
let trimHints: Record<string, string> = {}

const isAndroid = (d: DeviceInfoDto | undefined): boolean => d?.platform === 'ANDROID'
const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function setStatus(el: HTMLElement, text: string, error = false): void {
  el.textContent = text.trim() === '' ? ' ' : text
  el.className = error ? 'mtb-msg err' : 'mtb-msg'
}

function configure(): void {
  if (!api) return
  const d = device
  loaded = false
  updating = true
  level.value = '100'
  status.value = ''
  ac.checked = false
  usb.checked = false
  updating = false
  levelText.textContent = ' '
  const android = isAndroid(d)
  iosNote.style.display = d !== undefined && !android ? '' : 'none'
  iosNote.textContent = d !== undefined && !android ? IOS_NOTE : ' '
  for (const c of controls) c.style.display = android || d === undefined ? '' : 'none'
  setStatus(general, d === undefined ? 'Not connected' : ' ')
  setStatus(note, ' ')
  setStatus(trimStatus, ' ')
  trimBusy = false
  updateEnabled()
}

function updateEnabled(): void {
  const ok = isAndroid(device) && !busy && loaded
  for (const c of [level, status, ac, usb, reset]) (c as HTMLInputElement).disabled = !ok
  for (const c of [trimApp, trimLevel, trimSend]) (c as HTMLInputElement).disabled = !(isAndroid(device) && !trimBusy)
  refreshButton.disabled = !(isAndroid(device) && !busy)
}

function show(st: BatteryViewDto): void {
  updating = true
  if (st.level !== undefined) {
    level.value = String(st.level)
    levelText.textContent = `${st.level} %`
  }
  status.value = st.status ?? ''
  ac.checked = st.ac
  usb.checked = st.usb
  updating = false
  setStatus(note, st.updatesStopped ? 'A simulated battery state is active. It stays until you press Reset to real battery.' : ' ', st.updatesStopped)
  updateEnabled()
}

function refresh(): void {
  if (!api || !device || !isAndroid(device)) return
  const my = ++gen
  busy = true
  setStatus(general, 'Reading...')
  updateEnabled()
  api.request<BatteryViewDto>('read').then(
    (st) => {
      if (my !== gen) return
      busy = false
      loaded = true
      setStatus(general, ' ')
      show(st)
    },
    (e) => {
      if (my !== gen) return
      busy = false
      loaded = false
      setStatus(general, failureText(e), true)
      updateEnabled()
    },
  )
}

function sendTrim(): void {
  if (!api || !device || !isAndroid(device) || trimBusy) return
  const levelChoice = trimLevel.value
  const my = gen
  trimBusy = true
  setStatus(trimStatus, 'Sending...')
  updateEnabled()
  api.request<{ process: string; label: string }>('trim', { process: trimApp.value.trim(), level: levelChoice }).then(
    (r) => {
      if (my !== gen) return
      trimBusy = false
      setStatus(trimStatus, `Sent ${r.label} to ${r.process}`)
      updateEnabled()
    },
    (e) => {
      if (my !== gen) return
      trimBusy = false
      setStatus(trimStatus, failureText(e), true)
      updateEnabled()
    },
  )
}

/** Runs the write on the host, which reads the device back. A failure is shown and the controls show the truth. */
function run(message: string, method: 'change' | 'reset', params?: unknown): void {
  if (!api || !device || !loaded || busy) return
  const my = ++gen
  busy = true
  setStatus(general, message)
  updateEnabled()
  api.request<BatteryWriteResult>(method, params).then(
    (r) => {
      if (my !== gen) return
      busy = false
      if (r.view) show(r.view)
      if (r.failure !== undefined) setStatus(general, r.failure, true)
      else if (r.readError !== undefined) setStatus(general, `Applied, but reading the device back failed: ${r.readError}`, true)
      else setStatus(general, ' ')
      updateEnabled()
    },
    (e) => {
      if (my !== gen) return
      busy = false
      setStatus(general, failureText(e), true)
      updateEnabled()
    },
  )
}

export const batteryView: ToolView = {
  id: 'battery',
  title: 'Battery',

  mount(root, a) {
    api = a
    device = a.device
    level = h('input', { type: 'range', min: 0, max: 100, value: 100 })
    levelText = h('span', { class: 'mtb-msg' }, ' ')
    level.addEventListener('input', () => {
      levelText.textContent = `${level.value} %`
    })
    // Like the Kotlin slider: write when the thumb is released (change), not on every step.
    level.addEventListener('change', () => {
      if (!updating) run('Applying...', 'change', { change: { type: 'Level', percent: Number(level.value) } })
    })
    status = select([])
    status.addEventListener('change', () => {
      if (!updating && status.value !== '') run('Applying...', 'change', { change: { type: 'Status', status: status.value } })
    })
    const acBox = h('input', { type: 'checkbox' })
    acBox.addEventListener('change', () => {
      if (!updating) run('Applying...', 'change', { change: { type: 'Ac', on: acBox.checked } })
    })
    const usbBox = h('input', { type: 'checkbox' })
    usbBox.addEventListener('change', () => {
      if (!updating) run('Applying...', 'change', { change: { type: 'Usb', on: usbBox.checked } })
    })
    ac = acBox
    usb = usbBox
    reset = button('Reset to real battery', () => run('Resetting...', 'reset'))
    refreshButton = button('Refresh', refresh)
    general = h('span', { class: 'mtb-msg' }, ' ')
    note = h('div', { class: 'mtb-msg' }, ' ')
    iosNote = h('div', { class: 'mtb-muted' }, ' ')

    trimApp = h('input', { class: 'mtb-input', type: 'text', value: FOREGROUND, list: 'mtb-battery-apps', title: `Package or process name; "${FOREGROUND}" uses the app in front` })
    const apps = h('datalist', { id: 'mtb-battery-apps' }, h('option', { value: FOREGROUND }))
    trimLevel = select([])
    trimLevel.addEventListener('change', () => {
      trimLevel.title = trimHints[trimLevel.value] ?? ''
    })
    trimSend = button('Send memory warning', sendTrim)
    trimStatus = h('div', { class: 'mtb-msg' }, ' ')

    void a.request<{ statuses: Array<{ value: string; label: string }>; trimLevels: Array<{ value: string; label: string; hint: string }> }>('presets').then((p) => {
      status.replaceChildren(...p.statuses.map((s) => h('option', { value: s.value }, s.label)), h('option', { value: '' }, ''))
      trimHints = Object.fromEntries(p.trimLevels.map((l) => [l.value, l.hint]))
      trimLevel.replaceChildren(...p.trimLevels.map((l) => h('option', { value: l.value }, l.label)))
      trimLevel.value = 'RUNNING_CRITICAL'
      trimLevel.title = trimHints.RUNNING_CRITICAL ?? ''
    })

    const line = (text: string, ...c: HTMLElement[]): HTMLElement => row(h('span', { style: 'min-width:110px' }, text), ...c)
    const batteryRows = [
      line('Level:', level, levelText),
      line('Status:', status),
      line('Power:', h('label', { class: 'mtb-check' }, ac, 'AC powered')),
      line('', h('label', { class: 'mtb-check' }, usb, 'USB powered')),
      row(reset, refreshButton, general),
      note,
      h(
        'div',
        { class: 'mtb-muted', style: 'margin-top:6px' },
        'The values are set with dumpsys battery set; Android then stops following the real battery until you press Reset to real battery ' +
          '(dumpsys battery reset). The simulated state stays on the device after the tab or IDE closes. ' +
          'Whether an app reacts (low battery warnings, power saver) depends on the app and Android version and is not verified here.',
      ),
      h('hr', { style: 'width:100%;border:0;border-top:1px solid var(--vscode-panel-border);margin-top:10px' }),
      h('div', { style: 'font-weight:600;margin-top:6px' }, 'Memory warning'),
      line('App:', trimApp, apps),
      line('Level:', trimLevel, trimSend),
      trimStatus,
      h(
        'div',
        { class: 'mtb-muted', style: 'margin-top:6px' },
        "Runs adb shell am send-trim-memory <package> <level>, which makes the running app's onTrimMemory callbacks fire (the app must be running). " +
          'iOS simulators have no command for this: use Simulator > Debug > Simulate Memory Warning.',
      ),
    ]
    controls = batteryRows
    root.append(iosNote, ...batteryRows)
    configure()
  },

  deviceChanged(d) {
    device = d
    gen++
    busy = false
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
