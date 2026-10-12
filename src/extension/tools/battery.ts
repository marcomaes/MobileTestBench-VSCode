// ported-from: ui/BatteryPanel.kt
// Host half of the Battery tab: simulated battery of an Android device (`adb shell dumpsys battery set level|status|ac|usb`, `dumpsys battery
// reset`) and the memory warning (`am send-trim-memory`). iOS simulators have no simctl command for either, so the tab says so.
import { Apps } from '../../core/apps/apps'
import { BatteryStatuses, type BatteryChange, type BatteryState } from '../../core/battery/battery'
import { TrimLevels, type TrimLevel } from '../../core/memory/memory'
import type { ToolContext, ToolHost } from './toolHost'

export const FOREGROUND = 'Foreground app'

export interface BatteryViewDto {
  level?: number
  status?: string
  ac: boolean
  usb: boolean
  updatesStopped: boolean
}

export interface BatteryWriteResult {
  failure?: string
  view?: BatteryViewDto
  readError?: string
}

const msg = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))

const toDto = (st: BatteryState): BatteryViewDto => ({ level: st.level, status: st.status, ac: st.ac === true, usb: st.usb === true, updatesStopped: st.updatesStopped })

function backendOf(ctx: ToolContext) {
  const b = ctx.services.battery(ctx.device)
  if (!b) throw new Error('Not supported for this device')
  return b
}

export const batteryHost: ToolHost = {
  id: 'battery',
  title: 'Battery',
  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'presets':
        return {
          statuses: BatteryStatuses.values.map((s) => ({ value: s, label: BatteryStatuses.label(s) })),
          trimLevels: TrimLevels.values.map((l) => ({ value: l, label: TrimLevels.label(l), hint: TrimLevels.hint(l) })),
        }
      case 'read':
        return toDto(await backendOf(ctx).read())
      case 'change':
      case 'reset': {
        // A failure is reported and the state is re-read so the controls show the truth (Kotlin `run`).
        const b = backendOf(ctx)
        let failure: string | undefined
        try {
          if (method === 'reset') await b.reset()
          else await b.apply(p.change as BatteryChange)
        } catch (e) {
          failure = msg(e)
        }
        try {
          return { failure, view: toDto(await b.read()) } satisfies BatteryWriteResult
        } catch (e) {
          return { failure, readError: msg(e) } satisfies BatteryWriteResult
        }
      }
      case 'trim': {
        const typed = String(p.process ?? '').trim()
        const level = p.level as TrimLevel
        const process =
          typed === '' || typed === FOREGROUND
            ? (Apps.parseForeground(await ctx.services.mobilecliData(ctx.device, ['apps', 'foreground']))?.id ?? (() => { throw new Error('No foreground app found: type a package name') })())
            : typed
        const m = ctx.services.memory(ctx.device)
        if (!m) throw new Error('Not supported for this device')
        await m.trim(process, level)
        return { process, label: TrimLevels.label(level) }
      }
      default:
        throw new Error(`Battery: unknown method ${method}`)
    }
  },
}
