// ported-from: ui/LocationPanel.kt
// Host half of the Location tab: the mobilecli calls and the saved places (Kotlin setting `savedPlaces`, here in globalState).
import * as vscode from 'vscode'
import { LocationOverride, type Place } from '../../core/location/locationOverride'
import type { ToolContext, ToolHost } from './toolHost'

const PLACES_KEY = 'mobileTestBench.savedPlaces'

const saved = (ctx: ToolContext): Place[] => LocationOverride.decodePlaces(ctx.extensionContext.globalState.get<string[]>(PLACES_KEY, []))
const store = (ctx: ToolContext, places: Place[]): Thenable<void> => ctx.extensionContext.globalState.update(PLACES_KEY, places.map((p) => LocationOverride.encodePlace(p)))

async function call(ctx: ToolContext, args: string[]): Promise<void> {
  try {
    await ctx.services.mobilecliCall(ctx.device, args)
  } catch (e) {
    throw new Error(LocationOverride.friendlyError(e instanceof Error ? e.message : String(e)))
  }
}

export const locationHost: ToolHost = {
  id: 'location',
  title: 'Location',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, string>
    switch (method) {
      case 'places':
        return saved(ctx)
      case 'set': {
        const parsed = LocationOverride.parse(p.latitude, p.longitude)
        if (parsed.type === 'Invalid') throw new Error(parsed.reason)
        await call(ctx, LocationOverride.setArgs(parsed.latitude, parsed.longitude))
        return `Location set to ${LocationOverride.format(parsed.latitude)}, ${LocationOverride.format(parsed.longitude)} on ${ctx.device.name}`
      }
      case 'clear':
        await call(ctx, LocationOverride.CLEAR_ARGS)
        return `Override cleared on ${ctx.device.name}`
      case 'savePlace': {
        const parsed = LocationOverride.parse(p.latitude, p.longitude)
        if (parsed.type !== 'Ok') throw new Error(parsed.reason)
        const name = (await vscode.window.showInputBox({ title: 'Save Place', prompt: `Name for ${LocationOverride.format(parsed.latitude)}, ${LocationOverride.format(parsed.longitude)}:` }))?.trim()
        if (name === undefined) return { cancelled: true }
        const updated = LocationOverride.savePlace(saved(ctx), { name, latitude: parsed.latitude, longitude: parsed.longitude })
        if (!updated) throw new Error('Enter a name that is not one of the preset places')
        await store(ctx, updated)
        return { places: updated, selected: updated[updated.length - 1].name }
      }
      case 'deletePlace': {
        const target = saved(ctx).find((x) => x.name.toLowerCase() === String(p.name).toLowerCase())
        if (!target || LocationOverride.isPreset(target)) return { places: saved(ctx) }
        const updated = LocationOverride.deletePlace(saved(ctx), target)
        await store(ctx, updated)
        return { places: updated, deleted: target.name }
      }
      default:
        throw new Error(`Location: unknown method ${method}`)
    }
  },
}
