// ported-from: core/power/DevicePower.kt
import { isSameDevice, isUsable, makeDevice, type Device } from '../model'
import { MobilecliJson } from '../mobilecliJson'

export type PowerAction = 'BOOT' | 'SHUTDOWN' | 'REBOOT'

export const PowerActions = {
  label: (a: PowerAction): string => ({ BOOT: 'Boot', SHUTDOWN: 'Shut Down', REBOOT: 'Reboot' })[a],
  /** `mobilecli device <sub>`; the caller appends `--device <id>`. */
  args: (a: PowerAction): string[] => ['device', a.toLowerCase()],
  /** Boot blocks until the device is usable (8 s for a simulator, 30 s for a cold AVD), so it gets a long timeout. */
  timeoutMs: (a: PowerAction): number => (a === 'SHUTDOWN' ? 60_000 : 120_000),
  /** Shutdown and reboot lose the state of a running device, so they ask first. */
  needsConfirmation: (a: PowerAction): boolean => a !== 'BOOT',
  /** Not idempotent in mobilecli (booting a running device or shutting down an offline one is an error), so the state decides. */
  isAvailableFor(a: PowerAction, device: Device | undefined): boolean {
    if (!device) return false
    if (a === 'BOOT') return device.bootable
    return isUsable(device) && (device.kind === 'EMULATOR' || device.kind === 'SIMULATOR')
  },
  progressText: (a: PowerAction, d: Device): string => ({ BOOT: `Booting ${d.name}...`, SHUTDOWN: `Shutting down ${d.name}...`, REBOOT: `Rebooting ${d.name}...` })[a],
  confirmText: (a: PowerAction, d: Device): string =>
    ({ SHUTDOWN: `Shut down ${d.name}? Anything not saved in the device is lost.`, REBOOT: `Reboot ${d.name}? Anything not saved in the device is lost.`, BOOT: `Boot ${d.name}?` })[a],
}

/** Offline entries of `mobilecli devices --include-offline`: stopped AVDs and shut-down simulators. */
export const OfflineDevices = {
  /** Only entries with state "offline" that mobilecli can boot (emulators and simulators; physical devices are not offered). */
  parse(json: string): Device[] {
    const data = MobilecliJson.data(json) as { devices?: unknown } | undefined
    const devices = data && typeof data === 'object' ? data.devices : undefined
    if (!Array.isArray(devices)) return []
    const out: Device[] = []
    for (const o of devices as Array<Record<string, string> | null>) {
      if (!o || typeof o !== 'object' || o.state !== 'offline') continue
      const id = o.id?.trim() ? o.id : undefined
      if (!id) continue
      const platform = o.platform === 'android' ? 'ANDROID' : o.platform === 'ios' ? 'IOS' : undefined
      const type = o.type?.toLowerCase()
      const kind = type === 'emulator' ? 'EMULATOR' : type === 'simulator' ? 'SIMULATOR' : undefined
      if (!platform || !kind) continue
      const version = o.version?.trim() ? o.version : undefined
      out.push(
        makeDevice({
          id,
          name: o.name?.trim() ? o.name : id,
          platform,
          kind,
          osVersion: version ? `${platform === 'IOS' ? 'iOS ' : 'Android '}${version}` : undefined,
          state: 'offline',
          bootable: true,
        }),
      )
    }
    return out
  },

  /** The offline entries of [json] that are not already running in [online] (matched by UDID, or by AVD name for emulators). */
  missingFrom: (online: Device[], json: string): Device[] => OfflineDevices.parse(json).filter((off) => !online.some((d) => isSameDevice(d, off))),
}

/** Polling with an injectable clock so it can be tested without waiting. */
export const Polling = {
  /** Calls [probe] every [intervalMs] until it returns a value, [timeoutMs] passed, or [cancelled]. Probe errors count as "not yet". */
  async until<T>(opts: {
    timeoutMs: number
    intervalMs: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    cancelled?: () => boolean
    probe: () => Promise<T | undefined | null> | T | undefined | null
  }): Promise<T | undefined> {
    const now = opts.now ?? Date.now
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const deadline = now() + opts.timeoutMs
    for (;;) {
      if (opts.cancelled?.()) return undefined
      let found: T | undefined | null
      try {
        found = await opts.probe()
      } catch {
        found = undefined
      }
      if (found !== undefined && found !== null) return found
      if (now() >= deadline) return undefined
      await sleep(opts.intervalMs)
    }
  },

  /** The usable device equal to [target] in [devices], if any. */
  usableMatch: (devices: Device[], target: Device): Device | undefined => devices.find((d) => isUsable(d) && isSameDevice(d, target)),

  /** The entry to keep selected after a refresh: same id, else the same device (a usable one first, then an offline AVD entry after a shutdown). */
  reselect: (devices: Device[], previous: Device | undefined): Device | undefined =>
    devices.find((d) => d.id === previous?.id) ?? devices.find((d) => isUsable(d) && isSameDevice(d, previous)) ?? devices.find((d) => isSameDevice(d, previous)),
}
