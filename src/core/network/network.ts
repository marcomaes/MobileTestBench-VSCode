// ported-from: core/network/Network.kt
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'

const TIMEOUT_MS = 10_000
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)
const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))

/** Emulator console speed presets (`adb emu network speed <arg>`) with the bits per second the console reports for them. 0 means unlimited. */
export type SpeedPreset = 'FULL' | 'G5' | 'EVDO' | 'LTE' | 'HSDPA' | 'UMTS' | 'EDGE' | 'GPRS' | 'HSCSD' | 'GSM'

const SPEED: Record<SpeedPreset, { arg: string; label: string; downBits: number; upBits: number }> = {
  FULL: { arg: 'full', label: 'Full (no limit)', downBits: 0, upBits: 0 },
  G5: { arg: '5g', label: '5G (no limit)', downBits: 0, upBits: 0 },
  EVDO: { arg: 'evdo', label: 'EVDO (280 / 75 Mbit/s)', downBits: 280_000_000, upBits: 75_000_000 },
  LTE: { arg: 'lte', label: 'LTE (173 / 58 Mbit/s)', downBits: 173_000_000, upBits: 58_000_000 },
  HSDPA: { arg: 'hsdpa', label: 'HSDPA (14 / 5.8 Mbit/s)', downBits: 13_980_000, upBits: 5_760_000 },
  UMTS: { arg: 'umts', label: 'UMTS (384 kbit/s)', downBits: 384_000, upBits: 384_000 },
  EDGE: { arg: 'edge', label: 'EDGE (474 kbit/s)', downBits: 473_600, upBits: 473_600 },
  GPRS: { arg: 'gprs', label: 'GPRS (58 / 29 kbit/s)', downBits: 57_600, upBits: 28_800 },
  HSCSD: { arg: 'hscsd', label: 'HSCSD (58 / 14 kbit/s)', downBits: 57_600, upBits: 14_400 },
  GSM: { arg: 'gsm', label: 'GSM (14 kbit/s)', downBits: 14_400, upBits: 14_400 },
}

export const SpeedPresets = {
  values: ['FULL', 'G5', 'EVDO', 'LTE', 'HSDPA', 'UMTS', 'EDGE', 'GPRS', 'HSCSD', 'GSM'] as readonly SpeedPreset[],
  arg: (p: SpeedPreset): string => SPEED[p].arg,
  label: (p: SpeedPreset): string => SPEED[p].label,
  downBits: (p: SpeedPreset): number => SPEED[p].downBits,
  upBits: (p: SpeedPreset): number => SPEED[p].upBits,
}

/**
 * Emulator console latency presets (`adb emu network delay <arg>`). The numbers are what the console reported on the Android 17
 * emulator (gprs and umts both read 35-200 ms there, not the documented values); the label of a shown value always comes from the readback.
 */
export type DelayPreset = 'NONE' | 'GPRS' | 'EDGE' | 'UMTS'

const DELAY: Record<DelayPreset, { arg: string; label: string; minMs: number; maxMs: number }> = {
  NONE: { arg: 'none', label: 'None', minMs: 0, maxMs: 0 },
  GPRS: { arg: 'gprs', label: 'GPRS (35-200 ms)', minMs: 35, maxMs: 200 },
  EDGE: { arg: 'edge', label: 'EDGE (80-400 ms)', minMs: 80, maxMs: 400 },
  UMTS: { arg: 'umts', label: 'UMTS (35-200 ms)', minMs: 35, maxMs: 200 },
}

export const DelayPresets = {
  values: ['NONE', 'GPRS', 'EDGE', 'UMTS'] as readonly DelayPreset[],
  arg: (p: DelayPreset): string => DELAY[p].arg,
  label: (p: DelayPreset): string => DELAY[p].label,
  minMs: (p: DelayPreset): number => DELAY[p].minMs,
  maxMs: (p: DelayPreset): number => DELAY[p].maxMs,
}

/** What `adb emu network status` reports. */
export class EmuNetworkStatus {
  constructor(
    readonly downBits: number,
    readonly upBits: number,
    readonly minMs: number,
    readonly maxMs: number,
  ) {}

  get unlimited(): boolean {
    return this.downBits === 0 && this.upBits === 0
  }
  get noDelay(): boolean {
    return this.minMs === 0 && this.maxMs === 0
  }
  get normal(): boolean {
    return this.unlimited && this.noDelay
  }

  /** For example `473600 bits/s down, 473600 bits/s up, 80-400 ms`. */
  describe(): string {
    return (this.unlimited ? 'unlimited speed' : `${this.downBits} bits/s down, ${this.upBits} bits/s up`) + ', ' + (this.noDelay ? 'no delay' : `${this.minMs}-${this.maxMs} ms`)
  }
}

/** A snapshot of the connectivity switches. Undefined: could not be read, the reason is in [errors] (keys airplane, wifi, data, online, emulator). */
export interface NetworkState {
  readonly airplane: boolean | undefined
  readonly wifi: boolean | undefined
  readonly mobileData: boolean | undefined
  /** Whether Android has a default network (not a ping). */
  readonly online: boolean | undefined
  readonly emulator?: EmuNetworkStatus
  readonly errors?: Record<string, string>
}

/** Parsing and matching. Pure. */
export const NetworkParsers = {
  /** `cmd connectivity airplane-mode` prints `enabled` / `disabled`; `settings get global airplane_mode_on` prints 1 / 0. Undefined for anything else (`null`, an error). */
  airplane(text: string): boolean | undefined {
    switch (text.trim().toLowerCase()) {
      case 'enabled':
      case '1':
        return true
      case 'disabled':
      case '0':
        return false
      default:
        return undefined
    }
  },

  /** Only the first line of `cmd wifi status` counts (`Wifi is enabled`); the rest is long. `settings get global wifi_on` (1 / 0) is accepted too. */
  wifi(text: string): boolean | undefined {
    const raw = lines(text).find((l) => l.trim() !== '')
    if (raw === undefined) return undefined
    const first = raw.trim().toLowerCase()
    if (first === 'wifi is enabled' || first === '1') return true
    if (first === 'wifi is disabled' || first === '0') return false
    return undefined
  },

  /** `settings get global mobile_data`: 1 / 0, undefined for `null` or garbage. */
  mobileData(text: string): boolean | undefined {
    const t = text.trim()
    return t === '1' ? true : t === '0' ? false : undefined
  },

  /** From `dumpsys connectivity | grep -m1 "Active default network"`: `Active default network: none` is offline, any id is online. */
  online(text: string): boolean | undefined {
    const line = lines(text).find((l) => l.includes('Active default network'))
    if (line === undefined) return undefined
    const i = line.indexOf(':')
    const value = i < 0 ? '' : line.substring(i + 1).trim()
    return value === '' ? undefined : value.toLowerCase() !== 'none'
  },

  /**
   * The first `KO:` line of an `adb emu` answer, or undefined when there is none. adb exits 0 even for KO, and stray lines such as
   * `Warning: time of day goes back` can appear, so only OK / KO lines count.
   */
  emuError(output: string): string | undefined {
    const ko = lines(output).map((l) => l.trim()).find((l) => l.startsWith('KO'))
    if (ko === undefined) return undefined
    let rest = ko.slice(2)
    if (rest.startsWith(':')) rest = rest.slice(1)
    return rest.trim() || 'KO'
  },

  /** Parses `emu network status`; undefined when the numbers are not all there. */
  emuStatus(output: string): EmuNetworkStatus | undefined {
    const speeds = new Map<string, number>()
    for (const m of output.matchAll(/^\s*(download|upload) speed:\s+(\d+) bits\/s/gm)) speeds.set(m[1], Number(m[2]))
    const latency = new Map<string, number>()
    for (const m of output.matchAll(/^\s*(minimum|maximum) latency:\s+(\d+) ms/gm)) latency.set(m[1], Number(m[2]))
    const down = speeds.get('download')
    const up = speeds.get('upload')
    const min = latency.get('minimum')
    const max = latency.get('maximum')
    if (down === undefined || up === undefined || min === undefined || max === undefined) return undefined
    return new EmuNetworkStatus(down, up, min, max)
  },

  /** The preset equal to [status]; [prefer] wins when it matches too (full and 5g are the same numbers). Undefined means custom. */
  matchSpeed(status: EmuNetworkStatus, prefer?: SpeedPreset): SpeedPreset | undefined {
    const all = SpeedPresets.values.filter((p) => SpeedPresets.downBits(p) === status.downBits && SpeedPresets.upBits(p) === status.upBits)
    return prefer !== undefined && all.includes(prefer) ? prefer : all[0]
  },

  matchDelay(status: EmuNetworkStatus, prefer?: DelayPreset): DelayPreset | undefined {
    const all = DelayPresets.values.filter((p) => DelayPresets.minMs(p) === status.minMs && DelayPresets.maxMs(p) === status.maxMs)
    return prefer !== undefined && all.includes(prefer) ? prefer : all[0]
  },

  /** First non-blank line of an error, shortened. */
  errorLine(stdout: string, stderr: string, exit: number): string {
    const text = stderr.trim() || stdout.trim()
    return (lines(text).find((l) => l.trim() !== '') ?? `adb exited with code ${exit}`).slice(0, 200)
  },
}

/** adb shell / emu command lines. Pure. */
export class NetworkCommands {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
  ) {}

  private shell(...args: string[]): string[] {
    return [this.adb, '-s', this.serial, 'shell', ...args]
  }

  readAirplane = (): string[] => this.shell('cmd', 'connectivity', 'airplane-mode')
  readAirplaneSetting = (): string[] => this.shell('settings', 'get', 'global', 'airplane_mode_on')
  readWifi = (): string[] => this.shell('cmd', 'wifi', 'status')
  readMobileData = (): string[] => this.shell('settings', 'get', 'global', 'mobile_data')

  /** One quoted shell string, so grep runs on the device and only one line comes back (dumpsys is huge). */
  readDefaultNetwork = (): string[] => this.shell("dumpsys connectivity 2>/dev/null | grep -m1 'Active default network'")
  emuStatus = (): string[] => [this.adb, '-s', this.serial, 'emu', 'network', 'status']

  airplane = (enable: boolean): string[] => this.shell('cmd', 'connectivity', 'airplane-mode', enable ? 'enable' : 'disable')
  wifi = (enable: boolean): string[] => this.shell('svc', 'wifi', enable ? 'enable' : 'disable')
  mobileData = (enable: boolean): string[] => this.shell('svc', 'data', enable ? 'enable' : 'disable')
  speed = (arg: string): string[] => [this.adb, '-s', this.serial, 'emu', 'network', 'speed', arg]
  delay = (arg: string): string[] => [this.adb, '-s', this.serial, 'emu', 'network', 'delay', arg]
}

/** One thing the tab can change. */
export type NetworkKey = 'AIRPLANE' | 'WIFI' | 'DATA' | 'SPEED' | 'DELAY'

/** A write: a switch ([on]) or a console argument ([arg]). */
export interface NetworkChange {
  readonly key: NetworkKey
  readonly on?: boolean
  readonly arg?: string
}

/** Reads and writes the network conditions of one Android device. [emulator] gates the speed and latency part. */
export class AndroidNetwork {
  private readonly commands: NetworkCommands

  constructor(
    adb: string,
    serial: string,
    private readonly runner: CommandRunner,
    readonly emulator: boolean,
  ) {
    this.commands = new NetworkCommands(adb, serial)
  }

  /** Reads everything; a failed part becomes an error text, the rest still comes back. */
  async read(): Promise<NetworkState> {
    const errors: Record<string, string> = {}
    const part = async <T>(name: string, block: () => Promise<T | undefined>): Promise<T | undefined> => {
      try {
        return await block()
      } catch (e) {
        errors[name] = messageOf(e)
        return undefined
      }
    }

    const airplane = await part('airplane', async () => {
      // cmd connectivity airplane-mode exists from about Android 11; older builds fall back to the setting.
      const a = NetworkParsers.airplane((await this.text(this.commands.readAirplane(), true)) ?? '') ?? NetworkParsers.airplane((await this.text(this.commands.readAirplaneSetting())) ?? '')
      if (a === undefined) throw new CommandFailedException('Airplane mode state unknown')
      return a
    })
    const wifi = await part('wifi', async () => {
      const w = NetworkParsers.wifi((await this.text(this.commands.readWifi()))!)
      if (w === undefined) throw new CommandFailedException('Wi-Fi state unknown')
      return w
    })
    const data = await part('data', async () => {
      const d = NetworkParsers.mobileData((await this.text(this.commands.readMobileData()))!)
      if (d === undefined) throw new CommandFailedException('Mobile data state unknown')
      return d
    })
    const online = await part('online', async () => NetworkParsers.online((await this.text(this.commands.readDefaultNetwork(), true)) ?? ''))
    const emu = !this.emulator
      ? undefined
      : await part('emulator', async () => {
          const out = (await this.text(this.commands.emuStatus(), true))!
          const ko = NetworkParsers.emuError(out)
          if (ko !== undefined) throw new CommandFailedException(ko)
          const status = NetworkParsers.emuStatus(out)
          if (!status) throw new CommandFailedException(`Unexpected console output: ${out.trim().slice(0, 120)}`)
          return status
        })
    return { airplane, wifi, mobileData: data, online, emulator: emu, errors }
  }

  async write(key: NetworkKey, command: string[]): Promise<void> {
    const result = await this.runner.run(command, TIMEOUT_MS)
    if (key === 'SPEED' || key === 'DELAY') {
      // adb emu exits 0 even for KO.
      const ko = NetworkParsers.emuError(result.text + '\n' + result.stderr)
      if (ko !== undefined) throw new CommandFailedException(ko.slice(0, 200))
      if (!result.ok) throw new CommandFailedException(NetworkParsers.errorLine(result.text, result.stderr, result.exitCode))
    } else if (!result.ok) {
      throw new CommandFailedException(NetworkParsers.errorLine(result.text, result.stderr, result.exitCode))
    } else if (result.text.includes('Exception') || result.text.includes('Error:')) {
      // cmd and svc print a Java exception to stdout for a bad request.
      throw new CommandFailedException(NetworkParsers.errorLine(result.text, result.stderr, result.exitCode))
    }
  }

  setAirplane = (on: boolean): Promise<void> => this.write('AIRPLANE', this.commands.airplane(on))
  setWifi = (on: boolean): Promise<void> => this.write('WIFI', this.commands.wifi(on))
  setMobileData = (on: boolean): Promise<void> => this.write('DATA', this.commands.mobileData(on))
  setSpeed = (arg: string): Promise<void> => this.write('SPEED', this.commands.speed(arg))
  setDelay = (arg: string): Promise<void> => this.write('DELAY', this.commands.delay(arg))

  /** The write commands a [NetworkChange] stands for. */
  apply(change: NetworkChange): Promise<void> {
    switch (change.key) {
      case 'AIRPLANE': return this.setAirplane(change.on!)
      case 'WIFI': return this.setWifi(change.on!)
      case 'DATA': return this.setMobileData(change.on!)
      case 'SPEED': return this.setSpeed(change.arg!)
      case 'DELAY': return this.setDelay(change.arg!)
    }
  }

  private async text(command: string[], failOk = false): Promise<string | undefined> {
    const result = await this.runner.run(command, TIMEOUT_MS)
    if (!result.ok && !failOk) throw new CommandFailedException(NetworkParsers.errorLine(result.text, result.stderr, result.exitCode))
    return result.text
  }
}

/** What Reset to normal writes, and the values it remembers. Pure. */
export const NetworkReset = {
  /** Console argument for a measured speed: the preset name when one matches, else `<up>:<down>` in kbit/s. */
  speedArg(status: EmuNetworkStatus): string {
    if (status.unlimited) return 'full'
    const preset = NetworkParsers.matchSpeed(status)
    return preset !== undefined ? SpeedPresets.arg(preset) : `${Math.trunc(status.upBits / 1000)}:${Math.trunc(status.downBits / 1000)}`
  },

  delayArg(status: EmuNetworkStatus): string {
    if (status.noDelay) return 'none'
    const preset = NetworkParsers.matchDelay(status)
    return preset !== undefined ? DelayPresets.arg(preset) : `${status.minMs}:${status.maxMs}`
  },

  /**
   * The writes that bring [current] back to [originals] (the values before this tab changed anything), or to normal (airplane off, Wi-Fi and
   * data on, full speed, no delay) when nothing was remembered. Only values that differ are written. Order: airplane comes off first so
   * Wi-Fi and data can be switched on, and goes on last.
   */
  plan(originals: NetworkState | undefined, current: NetworkState, emulator: boolean): NetworkChange[] {
    const airplane = originals?.airplane ?? false
    const wifi = originals?.wifi ?? true
    const data = originals?.mobileData ?? true
    const out: NetworkChange[] = []
    if (!airplane && current.airplane !== false) out.push({ key: 'AIRPLANE', on: false })
    if (current.wifi !== wifi && !(airplane && current.airplane === true)) out.push({ key: 'WIFI', on: wifi })
    if (current.mobileData !== data) out.push({ key: 'DATA', on: data })
    if (airplane && current.airplane !== true) out.push({ key: 'AIRPLANE', on: true })
    if (emulator) {
      const want = originals?.emulator
      const speed = want ? NetworkReset.speedArg(want) : 'full'
      const delay = want ? NetworkReset.delayArg(want) : 'none'
      const now = current.emulator
      if (!now || now.upBits !== (want?.upBits ?? 0) || now.downBits !== (want?.downBits ?? 0)) out.push({ key: 'SPEED', arg: speed })
      if (!now || now.minMs !== (want?.minMs ?? 0) || now.maxMs !== (want?.maxMs ?? 0)) out.push({ key: 'DELAY', arg: delay })
    }
    return out
  },
}

/** The state before this tab's first change, per device, in memory only. */
export class NetworkBaseline {
  private readonly saved = new Map<string, NetworkState>()

  remember(deviceKey: string, state: NetworkState): void {
    if (!this.saved.has(deviceKey)) this.saved.set(deviceKey, state)
  }

  originals(deviceKey: string): NetworkState | undefined {
    return this.saved.get(deviceKey)
  }

  clear(deviceKey: string): void {
    this.saved.delete(deviceKey)
  }
}

/** Orchestration: write, remember after the first successful write, stop at the first error; Reset clears the baseline only on success. */
export class NetworkActions {
  constructor(readonly baseline: NetworkBaseline = new NetworkBaseline()) {}

  /** Returns the error text of the first failing write, or undefined. */
  async change(deviceKey: string, backend: AndroidNetwork, before: NetworkState, changes: NetworkChange[]): Promise<string | undefined> {
    const first = changes[0]
    if (!first) return undefined
    // Remember only once the first write went through, so a refused write leaves no baseline (and no "changed" note) behind.
    const failed = await this.attempt(backend, first)
    if (failed !== undefined) return failed
    this.baseline.remember(deviceKey, before)
    return this.write(backend, changes.slice(1))
  }

  /** Returns the failure text (undefined on success) and whether remembered values were used. */
  async reset(deviceKey: string, backend: AndroidNetwork): Promise<[string | undefined, boolean]> {
    const originals = this.baseline.originals(deviceKey)
    const failure = await this.write(backend, NetworkReset.plan(originals, await backend.read(), backend.emulator))
    if (failure === undefined) this.baseline.clear(deviceKey)
    return [failure, originals !== undefined]
  }

  private async attempt(backend: AndroidNetwork, c: NetworkChange): Promise<string | undefined> {
    try {
      await backend.apply(c)
      return undefined
    } catch (e) {
      return messageOf(e)
    }
  }

  private async write(backend: AndroidNetwork, changes: NetworkChange[]): Promise<string | undefined> {
    for (const c of changes) {
      const failed = await this.attempt(backend, c)
      if (failed !== undefined) return failed
    }
    return undefined
  }
}
