// ported-from: ui/NetworkPanel.kt
// Host half of the Network tab: airplane mode, Wi-Fi, mobile data and (emulators only) a speed and latency profile of an Android device.
// The webview half owns the generation counter and the settle loop (read back every second until a change has settled); this half
// reads, writes and describes. iOS simulators share the Mac network, so there the tab only explains what to use instead.
import {
  DelayPresets,
  NetworkActions,
  NetworkParsers,
  SpeedPresets,
  type DelayPreset,
  type NetworkChange,
  type NetworkState,
  type SpeedPreset,
} from '../../core/network/network'
import type { ToolContext, ToolHost } from './toolHost'

export interface StatusDto {
  text: string
  error: boolean
}

export interface NetworkViewDto {
  emulator: boolean
  /** The raw switches, for the settle conditions of the webview half. */
  state: { airplane?: boolean; wifi?: boolean; mobileData?: boolean; online?: boolean }
  hasEmulator: boolean
  speed?: string
  delay?: string
  status: { airplane: StatusDto; wifi: StatusDto; data: StatusDto; speed: StatusDto; delay: StatusDto; connection: StatusDto; changed: StatusDto }
}

export interface WriteResult {
  failure?: string
  restored?: boolean
}

const actions = new NetworkActions()

function backendOf(ctx: ToolContext) {
  const b = ctx.services.network(ctx.device)
  if (!b) throw new Error('Not supported for this device')
  return b
}

/** Shows what the device reported: the controls follow it, the status lines give the detail or the read error (Kotlin `showState`). */
function describe(ctx: ToolContext, emulator: boolean, st: NetworkState, pickedSpeed: SpeedPreset | undefined, pickedDelay: DelayPreset | undefined): NetworkViewDto {
  const errors = st.errors ?? {}
  const emu = st.emulator
  const sw = (key: string, value: boolean | undefined): StatusDto =>
    errors[key] !== undefined ? { text: errors[key], error: true } : { text: `Device reports: ${value === true ? 'on' : 'off'}`, error: false }
  let speed: StatusDto = { text: emulator ? ' ' : 'Speed profiles need an emulator', error: false }
  let delay: StatusDto = { text: emulator ? ' ' : 'Latency profiles need an emulator', error: false }
  if (emulator) {
    if (errors.emulator !== undefined) speed = { text: errors.emulator, error: true }
    else if (emu) {
      speed = {
        text: (emu.unlimited ? 'Console reports: unlimited' : `Console reports: ${emu.downBits} bits/s down, ${emu.upBits} bits/s up`) + (NetworkParsers.matchSpeed(emu) === undefined ? ' (custom)' : ''),
        error: false,
      }
      delay = { text: 'Console reports: ' + (emu.noDelay ? 'no delay' : `${emu.minMs}-${emu.maxMs} ms`) + (NetworkParsers.matchDelay(emu) === undefined ? ' (custom)' : ''), error: false }
    }
  }
  const online = st.online
  const connection: StatusDto = {
    text:
      online === true
        ? 'Connection: online (Android has a default network)'
        : online === false
          ? 'Connection: offline (no default network)'
          : errors.online !== undefined
            ? `Connection: unknown (${errors.online})`
            : 'Connection: unknown',
    error: online === false,
  }
  const changed = actions.baseline.originals(ctx.device.id) !== undefined
  const throttled = emu !== undefined && !emu.normal
  const changedNote: StatusDto = throttled
    ? { text: `Conditions changed by Mobile Test Bench or earlier: the emulator is throttled (${emu.describe()}). It stays so until you press Reset to normal.`, error: true }
    : changed
      ? { text: 'Conditions changed by MobileTestBench. They stay on the device until you press Reset to normal.', error: true }
      : { text: ' ', error: false }
  return {
    emulator,
    state: { airplane: st.airplane, wifi: st.wifi, mobileData: st.mobileData, online: st.online },
    hasEmulator: emu !== undefined,
    speed: emu ? NetworkParsers.matchSpeed(emu, pickedSpeed) : undefined,
    delay: emu ? NetworkParsers.matchDelay(emu, pickedDelay) : undefined,
    status: { airplane: sw('airplane', st.airplane), wifi: sw('wifi', st.wifi), data: sw('data', st.mobileData), speed, delay, connection, changed: changedNote },
  }
}

export const networkHost: ToolHost = {
  id: 'network',
  title: 'Network',
  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'presets':
        return {
          speeds: SpeedPresets.values.map((v) => ({ value: v, label: SpeedPresets.label(v) })),
          delays: DelayPresets.values.map((v) => ({ value: v, label: DelayPresets.label(v) })),
        }
      case 'read': {
        const b = backendOf(ctx)
        const st = await b.read()
        return describe(ctx, b.emulator, st, p.pickedSpeed as SpeedPreset | undefined, p.pickedDelay as DelayPreset | undefined)
      }
      case 'write': {
        // `before` is read right before the write, not the last shown state.
        const b = backendOf(ctx)
        const before = await b.read()
        const failure = await actions.change(ctx.device.id, b, before, p.changes as NetworkChange[])
        return { failure } satisfies WriteResult
      }
      case 'reset': {
        const [failure, restored] = await actions.reset(ctx.device.id, backendOf(ctx))
        return { failure, restored } satisfies WriteResult
      }
      default:
        throw new Error(`Network: unknown method ${method}`)
    }
  },
}
