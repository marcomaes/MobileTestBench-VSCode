// ported-from: ui/BiometricsPanel.kt
import { button, h, row, select } from '../ui'
import type { ToolApi, ToolView } from '../toolApi'
import type { DeviceInfoDto } from '../../protocol'
import type { BiometricsConfigDto } from '../../extension/tools/biometrics'

interface Result {
  text: string
  error: boolean
}

let api: ToolApi | undefined
let device: DeviceInfoDto | undefined
let visible = false
let busy = false
let mode: BiometricsConfigDto['mode'] = 'none'
/** Bumped for every click and device change: a late result of an older run is dropped. */
let gen = 0

let header: HTMLElement
let state: HTMLElement
let result: HTMLElement
let note: HTMLElement
let iosRow: HTMLElement
let androidRow: HTMLElement
let enroll: HTMLButtonElement
let unenroll: HTMLButtonElement
let match: HTMLButtonElement
let noMatch: HTMLButtonElement
let preset: HTMLSelectElement
let fingerId: HTMLInputElement
let touch: HTMLButtonElement
let lift: HTMLButtonElement
let refreshBtn: HTMLButtonElement

const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function show(r: Result): void {
  result.textContent = r.text
  result.className = r.error ? 'mtb-msg err' : ''
}

function updateEnabled(): void {
  const on = !busy
  for (const b of [enroll, unenroll, match, noMatch]) b.disabled = !(on && mode === 'ios')
  for (const b of [touch, lift, refreshBtn]) b.disabled = !(on && mode === 'android')
  preset.disabled = !(on && mode === 'android')
  fingerId.disabled = !(on && mode === 'android')
}

function configure(): void {
  if (!api) return
  const my = gen
  result.textContent = ' '
  state.textContent = ' '
  if (!device) {
    mode = 'none'
    header.textContent = 'Not connected'
    note.textContent = ' '
    iosRow.style.display = 'none'
    androidRow.style.display = 'none'
    state.style.display = 'none'
    updateEnabled()
    return
  }
  const isIos = device.platform === 'IOS'
  const isAndroid = device.platform === 'ANDROID'
  iosRow.style.display = isIos ? '' : 'none'
  androidRow.style.display = isAndroid ? '' : 'none'
  state.style.display = isIos || isAndroid ? '' : 'none'
  api.request<BiometricsConfigDto>('configure').then(
    (c) => {
      if (my !== gen) return
      mode = c.mode
      header.textContent = c.header
      note.textContent = c.note
      match.textContent = c.matchLabel
      noMatch.textContent = c.noMatchLabel
      updateEnabled()
      if (visible) refreshState()
    },
    (e) => {
      if (my === gen) show({ text: failureText(e), error: true })
    },
  )
}

function refreshState(): void {
  if (!api || !device || mode === 'none') return
  const my = ++gen
  const dev = device
  api.request<{ text: string }>('state').then(
    (r) => {
      if (my === gen && device === dev) state.textContent = r.text
    },
    (e) => {
      if (my === gen && device === dev) state.textContent = `State could not be read: ${failureText(e)}`
    },
  )
}

function execute(action: string): void {
  if (busy || !api || !device) return
  const dev = device
  const my = ++gen
  busy = true
  updateEnabled()
  result.textContent = 'Working...'
  result.className = 'mtb-msg'
  api.request<Result>('run', { action, fingerId: fingerId.value }).then(
    (r) => {
      if (my !== gen || device !== dev) return
      busy = false
      show(r)
      updateEnabled()
      refreshState()
    },
    (e) => {
      if (my !== gen || device !== dev) return
      busy = false
      show({ text: failureText(e), error: true })
      updateEnabled()
    },
  )
}

export const biometricsView: ToolView = {
  id: 'biometrics',
  title: 'Biometrics',

  mount(root, a) {
    api = a
    device = a.device
    header = h('div', {}, ' ')
    state = h('div', {}, ' ')
    result = h('div', { class: 'mtb-msg' }, ' ')
    note = h('div', { class: 'mtb-muted' }, ' ')
    enroll = button('Enroll', () => execute('enroll'))
    unenroll = button('Unenroll', () => execute('unenroll'))
    match = button('Matching face', () => execute('match'))
    noMatch = button('Non-matching face', () => execute('noMatch'))
    preset = select([
      { value: '1', label: 'Enrolled finger 1' },
      { value: '2', label: 'Finger 2' },
      { value: '99', label: 'Unknown finger 99 (not enrolled)' },
      { value: 'custom', label: 'Custom id' },
    ])
    fingerId = h('input', { class: 'mtb-input', type: 'text', value: '1', size: 4 })
    fingerId.readOnly = true
    preset.addEventListener('change', () => {
      if (preset.value !== 'custom') fingerId.value = preset.value
      fingerId.readOnly = preset.value !== 'custom'
    })
    touch = button('Touch sensor', () => execute('touch'))
    lift = button('Lift finger', () => execute('lift'))
    refreshBtn = button('Refresh', refreshState)
    iosRow = row(enroll, unenroll, match, noMatch)
    androidRow = row('Finger:', preset, 'id', fingerId, touch, lift, refreshBtn)
    root.append(header, state, iosRow, androidRow, result, note)
    configure()
  },

  deviceChanged(d) {
    device = d
    gen++
    busy = false
    mode = 'none'
    configure()
  },

  shown() {
    visible = true
    if (device && !busy) refreshState()
  },

  hidden() {
    visible = false
  },
}
