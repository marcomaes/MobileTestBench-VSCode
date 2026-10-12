// ported-from: core/discovery/DeviceParsers.kt
import { makeDevice, size, sizeIsEmpty, type Device, type Size } from '../model'
import { MobilecliException } from '../mobilecliJson'

export const AdbDevicesParser = {
  /** Parses `adb devices -l`. */
  parse(output: string): Device[] {
    const devices: Device[] = []
    for (const raw of output.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue
      const tokens = line.split(/\s+/)
      if (tokens.length < 2) continue
      const props: Record<string, string> = {}
      for (const t of tokens.slice(2)) {
        const i = t.indexOf(':')
        if (i >= 0) props[t.slice(0, i)] = t.slice(i + 1)
      }
      const serial = tokens[0]
      devices.push(
        makeDevice({
          id: serial,
          name: props.model?.replace(/_/g, ' ') ?? serial,
          platform: 'ANDROID',
          kind: serial.startsWith('emulator-') ? 'EMULATOR' : 'PHYSICAL',
          state: tokens[1],
        }),
      )
    }
    return devices
  },
}

export const SimctlDevicesParser = {
  /** Parses `xcrun simctl list devices booted -j`. */
  parse(json: string): Device[] {
    const devices = (JSON.parse(json) as { devices?: Record<string, Array<Record<string, string>>> }).devices
    if (!devices) return []
    return Object.entries(devices).flatMap(([runtime, list]) => {
      const os = SimctlDevicesParser.runtimeToVersion(runtime)
      return list.flatMap((o) =>
        o.state !== 'Booted'
          ? []
          : [makeDevice({ id: o.udid, name: o.name ?? 'Simulator', platform: 'IOS', kind: 'SIMULATOR', osVersion: os, state: o.state })],
      )
    })
  },

  /** "com.apple.CoreSimulator.SimRuntime.iOS-17-5" -> "iOS 17.5" */
  runtimeToVersion(runtime: string): string | undefined {
    const marker = 'SimRuntime.'
    const at = runtime.lastIndexOf(marker)
    const tail = at < 0 ? '' : runtime.slice(at + marker.length)
    if (!tail) return undefined
    const parts = tail.split('-')
    if (parts.length < 2) return tail
    return `${parts[0]} ${parts.slice(1).join('.')}`
  },
}

/** Parses `mobilecli devices` (JSON). Only physical iOS devices: simulators come from simctl, Android from adb. */
export const MobilecliDevicesParser = {
  parse(json: string): Device[] {
    const root = JSON.parse(json) as { status?: string; error?: string; data?: { devices?: Array<Record<string, string>> } }
    if (root.status === 'error') throw new MobilecliException(root.error ?? 'mobilecli failed')
    const devices = root.data?.devices
    if (!Array.isArray(devices)) return []
    const out: Device[] = []
    for (const o of devices) {
      const type = o.type?.toLowerCase()
      if (o.platform !== 'ios' || type === 'simulator' || !o.id) continue
      out.push(makeDevice({ id: o.id, name: o.name ?? o.id, platform: 'IOS', kind: 'PHYSICAL', osVersion: o.version ? `iOS ${o.version}` : undefined, state: o.state ?? 'online' }))
    }
    return out
  },
}

/** Parses the `screenSize` of `mobilecli device info` (iOS points). */
export const MobilecliDeviceInfoParser = {
  parseScreenSize(json: string): Size | undefined {
    const s = (JSON.parse(json) as { data?: { device?: { screenSize?: { width?: number; height?: number } } } }).data?.device?.screenSize
    if (typeof s?.width !== 'number' || typeof s?.height !== 'number') return undefined
    const result = size(Math.trunc(s.width), Math.trunc(s.height))
    return sizeIsEmpty(result) ? undefined : result
  },
}
