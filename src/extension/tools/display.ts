// ported-from: ui/DisplayPanel.kt
// Host half of the Display tab: dark mode, font size, animations, developer options, language and time zone. The webview half draws
// and owns the generation counters (`gen`, `localeGen`) and busy flags; this half reads and writes the device and describes what to show.
import * as vscode from 'vscode'
import {
  Appearances,
  DisplayActions,
  DisplayKeys,
  FontPresets,
  type DisplayChange,
  type DisplayKey,
  type DisplayState,
} from '../../core/display/display'
import { LocaleActions, LocalePresets, LocaleValidation, type LocaleState } from '../../core/display/locale'
import type { Device } from '../../core/model'
import type { ToolContext, ToolHost } from './toolHost'

/** A status line: the raw value, or the read error. */
export interface StatusDto {
  text: string
  error: boolean
}

/** Everything the Display controls need after a read. */
export interface DisplayViewDto {
  platform: 'ANDROID' | 'IOS'
  /** Which controls have a value that could be read (the others stay disabled). */
  enabled: { appearance: boolean; font: boolean; animations: boolean; touches: boolean; layout: boolean; pointer: boolean; dontKeep: boolean }
  appearanceChoices: Array<{ value: string; label: string }>
  /** Selected choice (an Appearance), undefined for a custom value. */
  appearance?: string
  fontChoices: Array<{ value: string; label: string }>
  font?: string
  animationsOff: boolean
  showTouches: boolean
  layoutBounds: boolean
  pointerLocation: boolean
  dontKeepActivities: boolean
  status: { appearance: StatusDto; font: StatusDto; animations?: StatusDto; touches?: StatusDto; layout?: StatusDto; pointer?: StatusDto; dontKeep?: StatusDto }
}

export interface LocaleViewDto {
  platform: 'ANDROID' | 'IOS'
  /** Selected language tag and zone to show in the editable boxes. */
  primary?: string
  timeZone?: string
  languageEnabled: boolean
  timeZoneEnabled: boolean
  languageStatus: StatusDto
  timeZoneStatus: StatusDto
  hint: string
}

export interface DisplayChangeResult {
  failure?: string
  view?: DisplayViewDto
  readError?: string
}

export interface LocaleChangeResult {
  failure?: string
  cancelled?: boolean
  view?: LocaleViewDto
}

export interface ResetResult {
  failure?: string
  restored: boolean
  note?: string
  view?: DisplayViewDto
  localeView?: LocaleViewDto
}

// One baseline per device id for the whole IDE session, like the Kotlin panel's actions (shared across devices).
const actions = new DisplayActions()
const localeActions = new LocaleActions()

const msg = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))
const supported = (d: Device): boolean => d.platform === 'ANDROID' || d.kind === 'SIMULATOR'

/** Shows what the device reported: the controls follow it, the status lines give the raw value or the read error (Kotlin `showState`). */
function describeDisplay(platform: 'ANDROID' | 'IOS', st: DisplayState): DisplayViewDto {
  const raw = st.values
  const err = (keys: readonly DisplayKey[]): string | undefined => keys.map((k) => st.errors.get(k)).find((e) => e !== undefined)
  const status = (keys: readonly DisplayKey[], text: string): StatusDto => {
    const e = err(keys)
    return e !== undefined ? { text: e, error: true } : { text, error: false }
  }
  const fontRaw = raw.get('FONT_SIZE') ?? (platform === 'ANDROID' ? 'unset (1.0)' : '?')
  const font = FontPresets.fromRaw(platform, raw.get('FONT_SIZE'))
  const view: DisplayViewDto = {
    platform,
    enabled: {
      appearance: st.has('APPEARANCE'),
      font: st.has('FONT_SIZE'),
      animations: st.animationsOff !== undefined,
      touches: st.showTouches !== undefined,
      layout: st.layoutBounds !== undefined,
      pointer: st.pointerLocation !== undefined,
      dontKeep: st.dontKeepActivities !== undefined,
    },
    appearanceChoices: Appearances.forPlatform(platform).map((a) => ({ value: a, label: Appearances.label(a) })),
    appearance: Appearances.fromRaw(platform, raw.get('APPEARANCE')),
    fontChoices: FontPresets.values.map((p) => ({ value: p, label: FontPresets.label(p) })),
    font,
    animationsOff: st.animationsOff === true,
    showTouches: st.showTouches === true,
    layoutBounds: st.layoutBounds === true,
    pointerLocation: st.pointerLocation === true,
    dontKeepActivities: st.dontKeepActivities === true,
    status: {
      appearance: status(['APPEARANCE'], `Device reports: ${raw.get('APPEARANCE')}`),
      font: status(['FONT_SIZE'], font === undefined ? `Custom value on the device: ${fontRaw}` : `Device reports: ${fontRaw}`),
    },
  }
  if (platform === 'ANDROID') {
    const scale = (k: DisplayKey): string => raw.get(k) ?? 'unset'
    view.status.animations = status(DisplayKeys.ANIMATIONS, `window ${scale('WINDOW_SCALE')}, transition ${scale('TRANSITION_SCALE')}, animator ${scale('ANIMATOR_SCALE')}`)
    view.status.touches = status(['SHOW_TOUCHES'], `show_touches: ${raw.get('SHOW_TOUCHES') ?? 'unset'}`)
    view.status.layout = status(['LAYOUT_BOUNDS'], `debug.layout: ${raw.get('LAYOUT_BOUNDS') ?? 'empty'}`)
    view.status.pointer = status(['POINTER_LOCATION'], `pointer_location: ${raw.get('POINTER_LOCATION') ?? 'unset'}`)
    view.status.dontKeep = status(['DONT_KEEP_ACTIVITIES'], `always_finish_activities: ${raw.get('DONT_KEEP_ACTIVITIES') ?? 'unset'}`)
  }
  return view
}

function describeLocale(platform: 'ANDROID' | 'IOS', st: LocaleState, canSetTimeZone: boolean): LocaleViewDto {
  const android = platform === 'ANDROID'
  const languageStatus: StatusDto =
    st.languageError !== undefined
      ? { text: st.languageError, error: true }
      : { text: `Device: ${st.languages && st.languages.length > 0 ? st.languages.join(', ') : 'unset'}` + (st.appleLocale !== undefined ? ` (region ${st.appleLocale})` : ''), error: false }
  const timeZoneStatus: StatusDto =
    st.timeZoneError !== undefined
      ? { text: st.timeZoneError, error: true }
      : st.timeZoneFollowsHost
        ? { text: `Mac: ${st.timeZone} (the iOS simulator follows the Mac; not changeable per simulator, use System Settings on the Mac)`, error: false }
        : { text: `Device: ${st.timeZone ?? 'unset'}`, error: false }
  return {
    platform,
    primary: st.primary,
    timeZone: st.timeZone,
    languageEnabled: st.languages !== undefined,
    timeZoneEnabled: canSetTimeZone && st.timeZoneError === undefined,
    languageStatus,
    timeZoneStatus,
    hint: android
      ? 'Language applies at once, no restart; running apps recreate their screens. Android keeps only ONE system language this way ' +
        '(the other languages are dropped; Reset can only bring back the first). Time zone applies at once; if Automatic time zone is on in Settings the network may switch it back. ' +
        'To test one app only, use Apps > Launch with options... > locale.'
      : "Language is written to the simulator's global preferences and takes effect for apps the next time they start (relaunch the app). " +
        'The Home screen keeps the old language until the simulator or SpringBoard restarts (not done automatically). ' +
        'To test one app only, use Apps > Launch with options... > locale.',
  }
}

function backendOf(ctx: ToolContext) {
  const b = ctx.services.display(ctx.device)
  if (!b) throw new Error('Not supported for this device')
  return b
}

function localeBackendOf(ctx: ToolContext) {
  const b = ctx.services.locale(ctx.device)
  if (!b) throw new Error('Not supported for this device')
  return b
}

async function readDisplay(ctx: ToolContext): Promise<DisplayViewDto> {
  const b = backendOf(ctx)
  return describeDisplay(b.platform, await b.read())
}

async function readLocale(ctx: ToolContext): Promise<LocaleViewDto> {
  const b = localeBackendOf(ctx)
  return describeLocale(b.platform, await b.read(), b.canSetTimeZone)
}

/** Applies [changes], then reads the device back (the Kotlin `apply`). `before` is read right before the write, not the last shown state. */
async function change(ctx: ToolContext, changes: DisplayChange[]): Promise<DisplayChangeResult> {
  const b = backendOf(ctx)
  const before = await b.read()
  const failure = await actions.change(ctx.device.id, b, before, changes)
  try {
    return { failure, view: describeDisplay(b.platform, await b.read()) }
  } catch (e) {
    return { failure, readError: msg(e) }
  }
}

async function localeWrite(ctx: ToolContext, work: (b: ReturnType<typeof localeBackendOf>, before: LocaleState) => Promise<string | undefined>): Promise<LocaleChangeResult> {
  const b = localeBackendOf(ctx)
  const before = await b.read()
  const failure = await work(b, before)
  const view = await b.read().then((st) => describeLocale(b.platform, st, b.canSetTimeZone)).catch(() => undefined)
  return { failure, view }
}

export const displayHost: ToolHost = {
  id: 'display',
  title: 'Display',
  appliesTo: supported,
  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'presets':
        return { languages: LocalePresets.LANGUAGES.map((t) => ({ value: t, label: LocalePresets.languageLabel(t) })), timeZones: [...LocalePresets.TIME_ZONES] }
      case 'read':
        return readDisplay(ctx)
      case 'readLocale':
        return readLocale(ctx)
      case 'change':
        // JSON turns an undefined value ("not set") into null on the way here.
        return change(ctx, (p.changes as Array<[DisplayKey, string | null | undefined]>).map(([k, v]): DisplayChange => [k, v ?? undefined]))
      case 'applyLanguage': {
        const tag = String(p.tag ?? '').trim()
        const invalid = LocaleValidation.languageError(tag)
        if (invalid !== undefined) return { failure: invalid } satisfies LocaleChangeResult
        return localeWrite(ctx, async (b, before) => {
          if (b.platform === 'ANDROID') {
            const warning = localeActions.androidListLossWarning(before, tag)
            // Decided from the live list: whenever more than one language would be dropped, ask.
            if (warning !== undefined && (await vscode.window.showWarningMessage(warning, { modal: true }, 'Change')) !== 'Change') return CANCELLED
          }
          return localeActions.changeLanguage(ctx.device.id, b, before, tag)
        }).then((r) => (r.failure === CANCELLED ? ({ cancelled: true, view: r.view } satisfies LocaleChangeResult) : r))
      }
      case 'applyTimeZone': {
        const id = String(p.id ?? '').trim()
        const invalid = LocaleValidation.timeZoneError(id)
        if (invalid !== undefined) return { failure: invalid } satisfies LocaleChangeResult
        return localeWrite(ctx, (b, before) => localeActions.changeTimeZone(ctx.device.id, b, before, id))
      }
      case 'reset': {
        // Restores what this tab changed. The Display part and the locale part run independently: either may be unavailable.
        const wantDisplay = p.display === true
        const wantLocale = p.locale === true
        const b = wantDisplay ? ctx.services.display(ctx.device) : undefined
        const lb = wantLocale ? ctx.services.locale(ctx.device) : undefined
        const outcome = b ? await actions.reset(ctx.device.id, ctx.device.platform, b) : undefined
        const localeOutcome = lb ? await localeActions.reset(ctx.device.id, lb) : undefined
        const view = b ? await b.read().then((st) => describeDisplay(b.platform, st)).catch(() => undefined) : undefined
        const localeView = lb ? await lb.read().then((st) => describeLocale(lb.platform, st, lb.canSetTimeZone)).catch(() => undefined) : undefined
        return {
          failure: outcome?.failure ?? localeOutcome?.failure,
          restored: outcome?.restored === true || localeOutcome?.restored === true,
          note: localeOutcome?.note,
          view,
          localeView,
        } satisfies ResetResult
      }
      default:
        throw new Error(`Display: unknown method ${method}`)
    }
  },
}

const CANCELLED = '\u0000cancelled'
