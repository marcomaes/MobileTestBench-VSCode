// ported-from: core/location/LocationOverride.kt

/** A named place. */
export interface Place {
  name: string
  latitude: number
  longitude: number
}

export const place = (name: string, latitude: number, longitude: number): Place => ({ name, latitude, longitude })

export type Parsed = { type: 'Ok'; latitude: number; longitude: number } | { type: 'Invalid'; reason: string }

const NUMBER = '[+-]?\\d+(?:\\.\\d+)?'
const numberRe = new RegExp(`^${NUMBER}$`)
const pair = new RegExp(`^\\s*(${NUMBER})\\s*(?:[,;]\\s*|\\s+)(${NUMBER})\\s*$`)

/** Kotlin `toDoubleOrNull` for the shapes that matter here: undefined for blank or non numeric text. */
function toDoubleOrNull(text: string): number | undefined {
  const t = text.trim()
  if (t.length === 0) return undefined
  const n = Number(t)
  return Number.isNaN(n) ? undefined : n
}

/** An error text, or undefined when [text] is a valid number within -[limit]..[limit]. */
function validate(text: string, label: string, limit: number): string | undefined {
  const trimmed = text.trim()
  const value = numberRe.test(trimmed) ? toDoubleOrNull(trimmed) : undefined
  if (value === undefined) return text.trim().length === 0 ? `${label} is required` : `${label} must be a number (use a dot as the decimal separator)`
  return value < -limit || value > limit ? `${label} must be between -${LocationOverride.format(limit)} and ${LocationOverride.format(limit)}` : undefined
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Pure helpers for the GPS location override: parsing, validation, presets, saved places and the mobilecli arguments. */
export const LocationOverride = {
  PRESETS: [
    place('Amsterdam', 52.3676, 4.9041),
    place('London', 51.5074, -0.1278),
    place('New York', 40.7128, -74.006),
    place('Tokyo', 35.6762, 139.6503),
    place('Sydney', -33.8688, 151.2093),
  ] as Place[],

  /** "lat, lon" (comma, semicolon or whitespace separated, dot decimals) as a pair of strings, or undefined when [text] is not such a pair. */
  parsePair(text: string): [string, string] | undefined {
    const m = pair.exec(text)
    return m ? [m[1], m[2]] : undefined
  },

  validateLatitude: (text: string): string | undefined => validate(text, 'Latitude', 90),
  validateLongitude: (text: string): string | undefined => validate(text, 'Longitude', 180),

  parse(latitude: string, longitude: string): Parsed {
    const latError = LocationOverride.validateLatitude(latitude)
    if (latError !== undefined) return { type: 'Invalid', reason: latError }
    const lonError = LocationOverride.validateLongitude(longitude)
    if (lonError !== undefined) return { type: 'Invalid', reason: lonError }
    return { type: 'Ok', latitude: Number(latitude.trim()), longitude: Number(longitude.trim()) }
  },

  /** Plain decimal with a dot, no exponent, trailing zeros removed (`52.3676`, `-74.006`, `90`). */
  format(value: number): string {
    let s = value.toFixed(6)
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
    return s === '-0' ? '0' : s
  },

  /** The `lat,lon` argument. A negative latitude gets a leading space (mobilecli trims it) so it is not taken for a flag; the device is appended by the caller. */
  coordinateArg(latitude: number, longitude: number): string {
    const s = `${LocationOverride.format(latitude)},${LocationOverride.format(longitude)}`
    return s.startsWith('-') ? ` ${s}` : s
  },

  setArgs: (latitude: number, longitude: number): string[] => ['device', 'location', 'set', LocationOverride.coordinateArg(latitude, longitude)],

  CLEAR_ARGS: ['device', 'location', 'clear'] as string[],

  /** The place list: presets, then saved places (a saved place with a preset's name is dropped), each saved entry encoded as `name|lat|lon`. */
  encodePlace: (p: Place): string => `${p.name.replaceAll('|', ' ')}|${LocationOverride.format(p.latitude)}|${LocationOverride.format(p.longitude)}`,

  decodePlace(entry: string): Place | undefined {
    const parts = entry.split('|')
    if (parts.length !== 3) return undefined
    const name = parts[0].trim()
    if (name.length === 0) return undefined
    const lat = toDoubleOrNull(parts[1])
    const lon = toDoubleOrNull(parts[2])
    if (lat === undefined || lon === undefined) return undefined
    if (LocationOverride.validateLatitude(parts[1]) !== undefined || LocationOverride.validateLongitude(parts[2]) !== undefined) return undefined
    return { name, latitude: lat, longitude: lon }
  },

  decodePlaces: (entries: string[]): Place[] => entries.map((e) => LocationOverride.decodePlace(e)).filter((p): p is Place => p !== undefined),

  isPreset: (p: Place): boolean => LocationOverride.PRESETS.some((x) => sameName(x.name, p.name)),

  /** Adds or replaces (by name, ignoring case) a saved place. Undefined when the name is blank or is a preset's name. */
  savePlace(saved: Place[], p: Place): Place[] | undefined {
    const name = p.name.trim().replaceAll('|', ' ')
    if (name.length === 0 || LocationOverride.isPreset({ ...p, name })) return undefined
    return [...saved.filter((s) => !sameName(s.name, name)), { ...p, name }]
  },

  deletePlace: (saved: Place[], p: Place): Place[] => saved.filter((s) => !sameName(s.name, p.name)),

  /** A short readable error from mobilecli's text. Its own validation messages are already clear and are passed through. */
  friendlyError(message: string): string {
    return (
      message
        .trim()
        .split(/\r\n|\n|\r/)
        .find((l) => l.trim().length > 0)
        ?.trim() ?? 'Location command failed'
    )
  },
}
