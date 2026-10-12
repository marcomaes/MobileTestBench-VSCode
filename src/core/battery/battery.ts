// ported-from: core/battery/Battery.kt
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'

/** Battery status values of `dumpsys battery set status <n>` (BatteryManager.BATTERY_STATUS_*). */
export type BatteryStatus = 'UNKNOWN' | 'CHARGING' | 'DISCHARGING' | 'NOT_CHARGING' | 'FULL'

const STATUS: Record<BatteryStatus, { code: number; label: string }> = {
  UNKNOWN: { code: 1, label: 'Unknown' },
  CHARGING: { code: 2, label: 'Charging' },
  DISCHARGING: { code: 3, label: 'Discharging' },
  NOT_CHARGING: { code: 4, label: 'Not charging' },
  FULL: { code: 5, label: 'Full' },
}

export const BatteryStatuses = {
  values: ['UNKNOWN', 'CHARGING', 'DISCHARGING', 'NOT_CHARGING', 'FULL'] as readonly BatteryStatus[],
  code: (s: BatteryStatus): number => STATUS[s].code,
  label: (s: BatteryStatus): string => STATUS[s].label,
  fromCode: (code: number | undefined): BatteryStatus | undefined => BatteryStatuses.values.find((s) => STATUS[s].code === code),
}

/** What `dumpsys battery` reports. [updatesStopped] is true while a simulated state is in force. */
export interface BatteryState {
  readonly level: number | undefined
  readonly status: BatteryStatus | undefined
  readonly ac: boolean | undefined
  readonly usb: boolean | undefined
  readonly wireless: boolean | undefined
  readonly updatesStopped: boolean
}

const toIntOrNull = (s: string | undefined): number | undefined => (s !== undefined && /^[+-]?\d+$/.test(s) ? Number(s) : undefined)
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)

export const BatteryParsers = {
  state(output: string): BatteryState | undefined {
    const values = new Map<string, string>()
    let stopped = false
    for (const raw of lines(output)) {
      const line = raw.trim()
      if (line.toLowerCase() === 'updates stopped') {
        stopped = true
        continue
      }
      const i = line.indexOf(':')
      if (i <= 0) continue
      const key = line.substring(0, i).trim().toLowerCase()
      if (!values.has(key)) values.set(key, line.substring(i + 1).trim())
    }
    const level = toIntOrNull(values.get('level'))
    if (level === undefined && values.get('status') === undefined) return undefined
    const bool = (key: string): boolean | undefined => {
      const v = values.get(key)?.toLowerCase()
      return v === 'true' ? true : v === 'false' ? false : undefined
    }
    return {
      level,
      status: BatteryStatuses.fromCode(toIntOrNull(values.get('status'))),
      ac: bool('ac powered'),
      usb: bool('usb powered'),
      wireless: bool('wireless powered'),
      updatesStopped: stopped,
    }
  },

  /** The error in the output of a `dumpsys battery set|reset` call, or undefined. dumpsys exits 0 for bad input. */
  error(output: string): string | undefined {
    const hit = lines(output)
      .map((l) => l.trim())
      .find((l) => {
        const lower = l.toLowerCase()
        return lower.startsWith('unknown') || lower.startsWith('bad') || l.includes('Exception') || lower.startsWith('error') || lower.startsWith('permission') || lower.includes('invalid')
      })
    return hit?.slice(0, 200)
  },

  errorLine(text: string, stderr: string, exitCode: number): string {
    return [...lines(stderr), ...lines(text)].map((l) => l.trim()).find((l) => l.length > 0) ?? `Exit code ${exitCode}`
  },
}

/** One write of the Battery tab. */
export type BatteryChange =
  | { readonly type: 'Level'; readonly percent: number }
  | { readonly type: 'Status'; readonly status: BatteryStatus }
  | { readonly type: 'Ac'; readonly on: boolean }
  | { readonly type: 'Usb'; readonly on: boolean }

export const BatteryChange = {
  Level: (percent: number): BatteryChange => ({ type: 'Level', percent }),
  Status: (status: BatteryStatus): BatteryChange => ({ type: 'Status', status }),
  Ac: (on: boolean): BatteryChange => ({ type: 'Ac', on }),
  Usb: (on: boolean): BatteryChange => ({ type: 'Usb', on }),
}

export const BatteryCommands = {
  validLevel: (percent: number): boolean => Number.isInteger(percent) && percent >= 0 && percent <= 100,

  read: (adb: string, serial: string): string[] => [adb, '-s', serial, 'shell', 'dumpsys', 'battery'],
  reset: (adb: string, serial: string): string[] => [adb, '-s', serial, 'shell', 'dumpsys', 'battery', 'reset'],

  set(adb: string, serial: string, change: BatteryChange): string[] {
    const base = [adb, '-s', serial, 'shell', 'dumpsys', 'battery', 'set']
    switch (change.type) {
      case 'Level': return [...base, 'level', String(change.percent)]
      case 'Status': return [...base, 'status', String(BatteryStatuses.code(change.status))]
      case 'Ac': return [...base, 'ac', change.on ? '1' : '0']
      case 'Usb': return [...base, 'usb', change.on ? '1' : '0']
    }
  },
}

/** Reads and writes the simulated battery of one Android device. */
export class AndroidBattery {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  async read(): Promise<BatteryState> {
    const r = await this.runner.run(BatteryCommands.read(this.adb, this.serial), 10_000)
    if (!r.ok) throw new CommandFailedException(BatteryParsers.errorLine(r.text, r.stderr, r.exitCode))
    const state = BatteryParsers.state(r.text)
    if (!state) throw new CommandFailedException(`Unexpected dumpsys battery output: ${r.text.trim().slice(0, 120)}`)
    return state
  }

  async apply(change: BatteryChange): Promise<void> {
    if (change.type === 'Level' && !BatteryCommands.validLevel(change.percent)) throw new CommandFailedException('Level must be 0 to 100')
    await this.run(BatteryCommands.set(this.adb, this.serial, change))
  }

  /** `dumpsys battery reset`: the real battery state is reported again. */
  reset(): Promise<void> {
    return this.run(BatteryCommands.reset(this.adb, this.serial))
  }

  private async run(command: string[]): Promise<void> {
    const r = await this.runner.run(command, 10_000)
    if (!r.ok) throw new CommandFailedException(BatteryParsers.errorLine(r.text, r.stderr, r.exitCode))
    const err = BatteryParsers.error(r.text + '\n' + r.stderr)
    if (err !== undefined) throw new CommandFailedException(err)
  }
}
