// ported-from: ui/DisplayPanel.kt
import { button, h, row, select } from '../ui'
import type { ToolApi, ToolView } from '../toolApi'
import type { DeviceInfoDto } from '../../protocol'
import type { DisplayChangeResult, DisplayViewDto, LocaleChangeResult, LocaleViewDto, ResetResult, StatusDto } from '../../extension/tools/display'

type Check = { box: HTMLInputElement; label: HTMLLabelElement }

let api: ToolApi | undefined
let device: DeviceInfoDto | undefined
let visible = false
let busy = false
/** Bumped for every read, write and device change: a result of an older run is dropped. */
let gen = 0
// Language and time zone have their own read/write cycle and generation counter.
let localeBusy = false
let localeGen = 0
let loaded = false
let localeLoaded = false
let updating = false

let appearance: HTMLSelectElement
let font: HTMLSelectElement
let animations: Check
let touches: Check
let layout: Check
let pointer: Check
let dontKeep: Check
let reset: HTMLButtonElement
let refreshButton: HTMLButtonElement
let language: HTMLInputElement
let timeZone: HTMLInputElement
let applyLanguageButton: HTMLButtonElement
let applyTimeZoneButton: HTMLButtonElement
const st: Record<string, HTMLElement> = {}
let general: HTMLElement
let localeHint: HTMLElement
let enabled = { appearance: false, font: false, animations: false, touches: false, layout: false, pointer: false, dontKeep: false }
let localeEnabled = { language: false, zone: false }

const supported = (d: DeviceInfoDto | undefined): boolean => d !== undefined && (d.platform === 'ANDROID' || d.kind === 'SIMULATOR')
const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function setStatus(el: HTMLElement, text: string, error: boolean): void {
  el.textContent = text.trim() === '' ? ' ' : text
  el.className = error ? 'mtb-msg err' : 'mtb-msg'
}
const showStatus = (el: HTMLElement, s: StatusDto | undefined): void => setStatus(el, s?.text ?? ' ', s?.error === true)

function checkRow(label: string, onchange: (v: boolean) => void): Check {
  const box = h('input', { type: 'checkbox' })
  box.addEventListener('change', () => {
    if (!updating) onchange(box.checked)
  })
  return { box, label: h('label', { class: 'mtb-check' }, box, label) }
}

function fillSelect(el: HTMLSelectElement, choices: Array<{ value: string; label: string }>, selected: string | undefined): void {
  el.replaceChildren(...choices.map((c) => h('option', { value: c.value }, c.label)))
  // A value that is none of the choices shows as "(custom)" and writes nothing.
  if (selected === undefined) {
    el.append(h('option', { value: '' }, '(custom)'))
    el.value = ''
  } else el.value = selected
}

function updateEnabled(): void {
  const ok = supported(device) && !busy && loaded
  appearance.disabled = !(ok && enabled.appearance)
  font.disabled = !(ok && enabled.font)
  animations.box.disabled = !(ok && enabled.animations)
  touches.box.disabled = !(ok && enabled.touches)
  layout.box.disabled = !(ok && enabled.layout)
  pointer.box.disabled = !(ok && enabled.pointer)
  dontKeep.box.disabled = !(ok && enabled.dontKeep)
  reset.disabled = !(supported(device) && !busy && !localeBusy && (loaded || localeLoaded))
  refreshButton.disabled = !(supported(device) && !busy)
}

function updateLocaleEnabled(): void {
  const ok = supported(device) && !localeBusy && localeLoaded
  language.disabled = !(ok && localeEnabled.language)
  applyLanguageButton.disabled = language.disabled
  timeZone.disabled = !(ok && localeEnabled.zone)
  applyTimeZoneButton.disabled = timeZone.disabled
}

/** Sets what the connected device kind offers, before anything is read. */
function configure(): void {
  if (!api) return
  const d = device
  updating = true
  appearance.replaceChildren()
  font.replaceChildren()
  for (const c of [animations, touches, layout, pointer, dontKeep]) c.box.checked = false
  language.value = ''
  timeZone.value = ''
  updating = false
  for (const k of ['language', 'timeZone', 'appearance', 'font', 'animations', 'touches', 'layout', 'pointer', 'dontKeep']) setStatus(st[k], ' ', false)
  localeHint.textContent = ' '
  const android = d?.platform === 'ANDROID'
  const title = d !== undefined && !android ? 'Android only' : ''
  animations.label.title = d !== undefined && !android ? 'Not supported on iOS simulators (no setting changes animations there)' : ''
  for (const c of [touches, layout, pointer, dontKeep]) c.label.title = title
  setStatus(general, d === undefined ? 'Not connected' : !supported(d) ? 'Not supported for physical iOS devices' : ' ', false)
  if (d !== undefined && !android && supported(d)) {
    setStatus(st.animations, 'Not supported on iOS simulators', false)
    for (const k of ['touches', 'layout', 'pointer', 'dontKeep']) setStatus(st[k], 'Android only', false)
  }
  loaded = false
  localeLoaded = false
  enabled = { appearance: false, font: false, animations: false, touches: false, layout: false, pointer: false, dontKeep: false }
  localeEnabled = { language: false, zone: false }
  updateEnabled()
  updateLocaleEnabled()
}

/** Shows what the device reported: the controls follow it, the status lines give the raw value or the read error. */
function showState(v: DisplayViewDto): void {
  updating = true
  fillSelect(appearance, v.appearanceChoices, v.appearance)
  fillSelect(font, v.fontChoices, v.font)
  animations.box.checked = v.animationsOff
  touches.box.checked = v.showTouches
  layout.box.checked = v.layoutBounds
  pointer.box.checked = v.pointerLocation
  dontKeep.box.checked = v.dontKeepActivities
  updating = false
  enabled = v.enabled
  loaded = true
  showStatus(st.appearance, v.status.appearance)
  showStatus(st.font, v.status.font)
  if (v.platform === 'ANDROID') {
    showStatus(st.animations, v.status.animations)
    showStatus(st.touches, v.status.touches)
    showStatus(st.layout, v.status.layout)
    showStatus(st.pointer, v.status.pointer)
    showStatus(st.dontKeep, v.status.dontKeep)
  }
  updateEnabled()
}

function showLocale(v: LocaleViewDto): void {
  if (v.primary !== undefined) language.value = v.primary
  if (v.timeZone !== undefined) timeZone.value = v.timeZone
  showStatus(st.language, v.languageStatus)
  showStatus(st.timeZone, v.timeZoneStatus)
  localeHint.textContent = v.hint
  localeEnabled = { language: v.languageEnabled, zone: v.timeZoneEnabled }
  localeLoaded = true
  updateLocaleEnabled()
}

/** Reads language and time zone of the device (own generation counter: a late result for another device is dropped). */
function refreshLocale(): void {
  if (!api || !device || !supported(device)) return
  if (localeBusy) return // a read or write is in flight; bumping the generation would drop its result
  const my = ++localeGen
  localeBusy = true
  updateLocaleEnabled()
  api.request<LocaleViewDto>('readLocale').then(
    (view) => {
      if (my !== localeGen) return
      localeBusy = false
      showLocale(view)
    },
    (e) => {
      if (my !== localeGen) return
      localeBusy = false
      localeLoaded = false
      setStatus(st.language, failureText(e), true)
      updateLocaleEnabled()
    },
  )
}

function refresh(): void {
  if (!api || !device || !supported(device)) return
  const my = ++gen
  busy = true
  setStatus(general, 'Reading...', false)
  updateEnabled()
  refreshLocale()
  api.request<DisplayViewDto>('read').then(
    (view) => {
      if (my !== gen) return
      busy = false
      setStatus(general, ' ', false)
      showState(view)
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

/** Writes [changes] on the host (which reads the device back); a failure goes to [target]. */
function change(changes: Array<[string, string | undefined]>, target: HTMLElement): void {
  if (!api || !device || !loaded || busy) return
  const my = ++gen
  busy = true
  updateEnabled()
  setStatus(target, 'Applying...', false)
  api.request<DisplayChangeResult>('change', { changes }).then(
    (r) => {
      if (my !== gen) return
      busy = false
      if (r.view) showState(r.view)
      else updateEnabled()
      if (r.failure !== undefined) {
        setStatus(target, r.failure, true)
      } else if (!r.view) setStatus(general, `Applied, but reading the device back failed: ${r.readError}`, true)
    },
    (e) => {
      if (my !== gen) return
      busy = false
      updateEnabled()
      setStatus(target, failureText(e), true)
    },
  )
}

function localeWrite(method: string, params: unknown, target: HTMLElement): void {
  if (!api || !device || !localeLoaded || localeBusy) return
  const my = ++localeGen
  localeBusy = true
  updateLocaleEnabled()
  setStatus(target, 'Applying...', false)
  api.request<LocaleChangeResult>(method, params).then(
    (r) => {
      if (my !== localeGen) return
      localeBusy = false
      if (r.view) showLocale(r.view)
      else updateLocaleEnabled()
      if (r.cancelled) setStatus(target, ' ', false)
      else if (r.failure !== undefined) setStatus(target, r.failure, true)
    },
    (e) => {
      if (my !== localeGen) return
      localeBusy = false
      updateLocaleEnabled()
      setStatus(target, failureText(e), true)
    },
  )
}

/** Restores what this tab changed. The Display part and the locale part run independently: either may be unavailable. */
function resetToDefaults(): void {
  if (!api || !device || busy || localeBusy) return
  const display = loaded
  const locale = localeLoaded
  if (!display && !locale) return
  const my = ++gen
  const myLocale = ++localeGen
  if (display) busy = true
  if (locale) localeBusy = true
  updateEnabled()
  updateLocaleEnabled()
  setStatus(general, 'Applying...', false)
  api.request<ResetResult>('reset', { display, locale }).then(
    (r) => {
      if (my !== gen || myLocale !== localeGen) return
      busy = false
      localeBusy = false
      if (r.view) showState(r.view)
      if (r.localeView) showLocale(r.localeView)
      updateEnabled()
      updateLocaleEnabled()
      if (r.failure !== undefined) setStatus(general, r.failure, true)
      else setStatus(general, (r.restored ? 'Restored what this tab changed' : 'Reset to the platform defaults') + (r.note ? `. ${r.note}` : ''), false)
    },
    (e) => {
      if (my !== gen || myLocale !== localeGen) return
      busy = false
      localeBusy = false
      updateEnabled()
      updateLocaleEnabled()
      setStatus(general, failureText(e), true)
    },
  )
}

export const displayView: ToolView = {
  id: 'display',
  title: 'Display',

  mount(root, a) {
    api = a
    device = a.device
    const statusLine = (key: string): HTMLElement => (st[key] = h('span', { class: 'mtb-msg' }, ' '))
    appearance = select([])
    font = select([])
    appearance.addEventListener('change', () => {
      if (updating || appearance.value === '') return
      const platform = device?.platform
      if (!platform) return
      // The raw value per platform is computed by the host: send the choice, not the raw text.
      change([['APPEARANCE', appearanceRaw(platform, appearance.value)]], st.appearance)
    })
    font.addEventListener('change', () => {
      if (updating || font.value === '') return
      const platform = device?.platform
      if (!platform) return
      change([['FONT_SIZE', fontRaw(platform, font.value)]], st.font)
    })
    animations = checkRow('Disable animations', (off) => {
      // Unset (undefined) is the default scale 1.0 and also what a device that never customised it has.
      change(['WINDOW_SCALE', 'TRANSITION_SCALE', 'ANIMATOR_SCALE'].map((k) => [k, off ? '0' : undefined]), st.animations)
    })
    touches = checkRow('Show touches', (on) => change([['SHOW_TOUCHES', on ? '1' : '0']], st.touches))
    layout = checkRow('Layout bounds', (on) => change([['LAYOUT_BOUNDS', on ? 'true' : undefined]], st.layout))
    pointer = checkRow('Pointer location', (on) => change([['POINTER_LOCATION', on ? '1' : '0']], st.pointer))
    dontKeep = checkRow("Don't keep activities", (on) => change([['DONT_KEEP_ACTIVITIES', on ? '1' : '0']], st.dontKeep))
    reset = button('Reset to defaults', resetToDefaults)
    refreshButton = button('Refresh', refresh)
    general = h('span', { class: 'mtb-msg' }, ' ')

    language = h('input', { class: 'mtb-input', type: 'text', list: 'mtb-display-languages' })
    timeZone = h('input', { class: 'mtb-input', type: 'text', list: 'mtb-display-zones' })
    const languages = h('datalist', { id: 'mtb-display-languages' })
    const zones = h('datalist', { id: 'mtb-display-zones' })
    void a.request<{ languages: Array<{ value: string; label: string }>; timeZones: string[] }>('presets').then((p) => {
      languages.replaceChildren(...p.languages.map((l) => h('option', { value: l.value }, l.label)))
      zones.replaceChildren(...p.timeZones.map((z) => h('option', { value: z })))
    })
    applyLanguageButton = button('Apply', () => localeWrite('applyLanguage', { tag: language.value.trim() }, st.language))
    applyTimeZoneButton = button('Apply', () => localeWrite('applyTimeZone', { id: timeZone.value.trim() }, st.timeZone))
    localeHint = h('div', { class: 'mtb-muted' }, ' ')

    const line = (label: string | undefined, control: HTMLElement, key: string): HTMLElement =>
      row(h('span', { style: 'min-width:110px' }, label ?? ''), control, statusLine(key))
    root.append(
      line('Dark mode:', appearance, 'appearance'),
      line('Font size:', font, 'font'),
      line('Animations:', animations.label, 'animations'),
      line('Developer options:', touches.label, 'touches'),
      line(undefined, layout.label, 'layout'),
      line(undefined, pointer.label, 'pointer'),
      line(undefined, dontKeep.label, 'dontKeep'),
      row(h('span', { style: 'min-width:110px' }, ''), reset, refreshButton, general),
      line('Language:', row(language, applyLanguageButton), 'language'),
      line('Time zone:', row(timeZone, applyTimeZoneButton), 'timeZone'),
      localeHint,
      languages,
      zones,
      h(
        'div',
        { class: 'mtb-muted', style: 'margin-top:8px' },
        'Changes apply at once and stay on the device until you change them again or press Reset to defaults, which restores what this tab changed. ' +
          'Layout bounds is redrawn by running apps; touch the screen if a static one does not update.',
      ),
    )
    configure()
  },

  deviceChanged(d) {
    device = d
    gen++
    busy = false
    loaded = false
    localeGen++
    localeBusy = false
    localeLoaded = false
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

// The webview cannot import core/display (it pulls in node modules), so the two small raw tables are repeated here.
// Kept in sync with Appearance / FontPreset in core/display/display.ts.
function appearanceRaw(platform: string, choice: string): string {
  const android: Record<string, string> = { AUTO: 'auto', LIGHT: 'no', DARK: 'yes' }
  const ios: Record<string, string> = { LIGHT: 'light', DARK: 'dark' }
  return (platform === 'ANDROID' ? android : ios)[choice]
}

function fontRaw(platform: string, choice: string): string {
  const android: Record<string, string> = { SMALL: '0.85', DEFAULT: '1.0', LARGE: '1.15', LARGEST: '1.3' }
  const ios: Record<string, string> = { SMALL: 'small', DEFAULT: 'large', LARGE: 'extra-extra-large', LARGEST: 'accessibility-extra-extra-extra-large' }
  return (platform === 'ANDROID' ? android : ios)[choice]
}
