// ported-from: core/project/ProjectLayout.kt
import type { ForegroundApp } from '../apps/apps'
import { isUsable, type Device } from '../model'

const DEFAULT_MIRROR = 0.5
const DEFAULT_TOOLS = 0.68
const MIN = 0.1
const MAX = 0.9

const clamp = (value: number, fallback: number): number => (Number.isNaN(value) || value < MIN || value > MAX ? fallback : value)

/** A partial update of a [ProjectLayout]: undefined leaves a field alone. */
export interface LayoutPatch {
  lastDeviceId?: string
  lastDeviceName?: string
  inspectorOpen?: boolean
  toolsOpen?: boolean
  toolsTab?: string
  mirrorProportion?: number
  toolsProportion?: number
}

/** What the panel remembers per project: the last device and the layout. Pure data, no IDE types. */
export class ProjectLayout {
  static readonly DEFAULT_MIRROR = DEFAULT_MIRROR
  static readonly DEFAULT_TOOLS = DEFAULT_TOOLS

  readonly lastDeviceId: string
  readonly lastDeviceName: string
  readonly inspectorOpen: boolean
  readonly toolsOpen: boolean
  /** Title of the selected Device Tools tab; empty means the first one. */
  readonly toolsTab: string
  /** Share of the mirror in the mirror/inspector splitter. */
  readonly mirrorProportion: number
  /** Share of the mirror area in the vertical splitter above Device Tools. */
  readonly toolsProportion: number

  constructor(p: LayoutPatch = {}) {
    this.lastDeviceId = p.lastDeviceId ?? ''
    this.lastDeviceName = p.lastDeviceName ?? ''
    this.inspectorOpen = p.inspectorOpen ?? false
    this.toolsOpen = p.toolsOpen ?? false
    this.toolsTab = p.toolsTab ?? ''
    this.mirrorProportion = p.mirrorProportion ?? DEFAULT_MIRROR
    this.toolsProportion = p.toolsProportion ?? DEFAULT_TOOLS
  }

  private copy(p: LayoutPatch): ProjectLayout {
    return new ProjectLayout({ ...this.toJSON(), ...p })
  }

  /** Replaces unusable values (NaN, outside 0.1..0.9) by the defaults and trims the strings. */
  normalized(): ProjectLayout {
    return this.copy({
      lastDeviceId: this.lastDeviceId.trim(),
      lastDeviceName: this.lastDeviceName.trim(),
      toolsTab: this.toolsTab.trim(),
      mirrorProportion: clamp(this.mirrorProportion, DEFAULT_MIRROR),
      toolsProportion: clamp(this.toolsProportion, DEFAULT_TOOLS),
    })
  }

  /** Applies the fields that are set in [patch]; the others keep their value. */
  merge(patch: LayoutPatch): ProjectLayout {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) as LayoutPatch
    return this.copy(defined).normalized()
  }

  withDevice(device: Device): ProjectLayout {
    return this.copy({ lastDeviceId: device.id, lastDeviceName: device.name })
  }

  /** The saved tab when it still exists (tabs get renamed between versions), else undefined. */
  tabIn(titles: string[]): string | undefined {
    return titles.includes(this.toolsTab) ? this.toolsTab : undefined
  }

  equals(other: ProjectLayout): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON())
  }

  toJSON(): Required<LayoutPatch> {
    return {
      lastDeviceId: this.lastDeviceId,
      lastDeviceName: this.lastDeviceName,
      inspectorOpen: this.inspectorOpen,
      toolsOpen: this.toolsOpen,
      toolsTab: this.toolsTab,
      mirrorProportion: this.mirrorProportion,
      toolsProportion: this.toolsProportion,
    }
  }

  /** Reads a stored value; anything of the wrong type is ignored and the result is normalized. */
  static fromJSON(value: unknown): ProjectLayout {
    if (typeof value !== 'object' || value === null) return new ProjectLayout()
    const o = value as Record<string, unknown>
    const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
    const bool = (k: string): boolean | undefined => (typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined)
    const num = (k: string): number | undefined => (typeof o[k] === 'number' ? (o[k] as number) : undefined)
    return new ProjectLayout({
      lastDeviceId: str('lastDeviceId'),
      lastDeviceName: str('lastDeviceName'),
      inspectorOpen: bool('inspectorOpen'),
      toolsOpen: bool('toolsOpen'),
      toolsTab: str('toolsTab'),
      mirrorProportion: num('mirrorProportion'),
      toolsProportion: num('toolsProportion'),
    }).normalized()
  }
}

/** Finds the remembered device among the discovered ones. */
export const LastDevice = {
  /** Same id first, else (an emulator serial changes between boots, a simulator keeps its UDID) the same name; undefined when [id] and [name] are blank or nothing matches. */
  find(devices: Device[], id: string, name: string): Device | undefined {
    if (id.trim() === '' && name.trim() === '') return undefined
    return (
      devices.find((d) => id.trim() !== '' && d.id === id) ??
      devices.find((d) => name.trim() !== '' && d.name === name && (isUsable(d) || d.bootable))
    )
  },
}

/** How the live foreground app shows in the status area. */
export const ForegroundText = {
  UNKNOWN: '–',

  /** One line: app name and id; just the name when both are equal; the home screen is named as such. */
  label(app: ForegroundApp | undefined): string {
    if (!app) return ForegroundText.UNKNOWN
    if (app.isHome) return 'Home screen'
    if (app.name === app.id || app.name.trim() === '') return app.id
    return `${app.name} (${app.id})`
  },

  tooltip(app: ForegroundApp | undefined): string {
    if (!app) return 'Foreground app: not available'
    return `Foreground app: ${app.name} (${app.id})` + (app.activity ? `, ${app.activity}` : '') + '. Click to copy the package id.'
  },

  /** What a click copies; undefined when there is nothing to copy. */
  copyText(app: ForegroundApp | undefined): string | undefined {
    return app && app.id.trim() !== '' ? app.id : undefined
  },
}
