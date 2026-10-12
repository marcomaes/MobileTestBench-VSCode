// ported-from: core/Model.kt

export type Platform = 'ANDROID' | 'IOS'

export type DeviceKind = 'EMULATOR' | 'SIMULATOR' | 'PHYSICAL'

export interface Device {
  readonly id: string
  readonly name: string
  readonly platform: Platform
  readonly kind: DeviceKind
  readonly osVersion?: string
  readonly state: string
  /** True for an offline entry that mobilecli can boot (a stopped AVD or shut-down simulator). Not the same as adb's "offline" transport state. */
  readonly bootable: boolean
  /** The AVD name of a running Android emulator (the adb serial is not stable across boots). */
  readonly avdName?: string
}

export function makeDevice(d: Pick<Device, 'id' | 'name' | 'platform' | 'kind'> & Partial<Device>): Device {
  return { state: 'online', bootable: false, ...d }
}

export const isUsable = (d: Device): boolean => d.state === 'device' || d.state === 'online' || d.state === 'Booted'

export function displayName(d: Device): string {
  let s = d.name
  if (d.osVersion) s += ' ' + d.osVersion
  s += ` [${d.kind.toLowerCase()}]`
  if (d.bootable) s += ' (offline)'
  else if (!isUsable(d)) s += ` (${d.state})`
  return s
}

/** Identifies "the same emulator" across a boot or reboot: the AVD name of a running or a bootable emulator. */
export const avdKey = (d: Device): string | undefined => d.avdName ?? (d.bootable && d.kind === 'EMULATOR' ? d.id : undefined)

/** Same UDID or serial, or the same Android emulator (matched by AVD name, since the serial changes between boots). */
export function isSameDevice(a: Device, b: Device | undefined | null): boolean {
  if (!b) return false
  if (a.id === b.id) return true
  const key = avdKey(a)
  return a.platform === b.platform && key !== undefined && key === avdKey(b)
}

/** Hardware and navigation keys the toolbar and keyboard forwarding can send. */
export type DeviceKey = 'HOME' | 'BACK' | 'APP_SWITCH' | 'ENTER' | 'DELETE' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'POWER'

export interface Size {
  readonly width: number
  readonly height: number
}

export const size = (width: number, height: number): Size => ({ width, height })
export const sizeIsEmpty = (s: Size): boolean => s.width <= 0 || s.height <= 0
export const sizeIsLandscape = (s: Size): boolean => s.width > s.height
export const sizeSwapped = (s: Size): Size => ({ width: s.height, height: s.width })
export const sizeEquals = (a: Size | undefined, b: Size | undefined): boolean => a?.width === b?.width && a?.height === b?.height

/** Axis aligned rectangle in the device's logical coordinate space. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
export const rectArea = (r: Rect): number => r.width * r.height
export const rectCenterX = (r: Rect): number => r.x + Math.trunc(r.width / 2)
export const rectCenterY = (r: Rect): number => r.y + Math.trunc(r.height / 2)
export const rectContainsPoint = (r: Rect, px: number, py: number): boolean => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height
/** True when [other] lies completely inside [r]. */
export const rectContainsRect = (r: Rect, other: Rect): boolean =>
  other.x >= r.x && other.y >= r.y && other.x + other.width <= r.x + r.width && other.y + other.height <= r.y + r.height
