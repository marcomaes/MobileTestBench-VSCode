// ported-from: core/android/AdbClient.kt
import { size, type Size } from '../model'
import type { CommandRunner } from '../exec/commandRunner'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const AdbOutput = {
  /** Drops text before the PNG signature: devices with several displays (foldables) print `[Warning] Multiple displays were found...` first. */
  pngFrom(output: Buffer): Buffer {
    const start = output.indexOf(PNG_SIGNATURE)
    return start <= 0 ? output : output.subarray(start)
  },

  /** Parses `adb shell wm size`; an override size wins over the physical size. */
  parseWmSize(output: string): Size | undefined {
    const sizes: Record<string, Size> = {}
    for (const m of output.matchAll(/(Physical|Override) size:\s*(\d+)x(\d+)/g)) sizes[m[1]] = size(Number(m[2]), Number(m[3]))
    return sizes.Override ?? sizes.Physical
  },

  /** Parses `adb shell wm density`; an override density wins over the physical density. */
  parseWmDensity(output: string): number | undefined {
    const values: Record<string, number> = {}
    for (const m of output.matchAll(/(Physical|Override) density:\s*(\d+)/g)) values[m[1]] = Number(m[2])
    const v = values.Override ?? values.Physical
    return v !== undefined && v > 0 ? v : undefined
  },

  /** `adb shell input text` goes through the device shell, so shell metacharacters must be escaped and spaces must be sent as %s. */
  escapeInputText(text: string): string {
    const special = '()<>|;&*\\~"\'`$?#![]{}'
    let out = ''
    for (const c of text) {
      if (c === ' ') out += '%s'
      else if (c === '%') out += '\\%'
      else if (special.includes(c)) out += '\\' + c
      else out += c
    }
    return out
  },
}

export const KEYCODE = {
  HOME: 3,
  BACK: 4,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  DEL: 67,
  CTRL_LEFT: 113,
  A: 29,
  APP_SWITCH: 187,
} as const

export class AdbClient {
  constructor(
    private readonly adb: string,
    private readonly runner: CommandRunner,
  ) {}

  /** The adb program this client runs (a path or just `adb`). */
  get executable(): string {
    return this.adb
  }

  /** Command line of the device log: the last 300 lines, then following (long running; end it by ending the process). */
  logcatCommand(serial: string): string[] {
    return [this.adb, '-s', serial, 'logcat', '-v', 'threadtime', '-T', '300']
  }

  /** The process ids of an app by package name (`pidof`); empty when it is not running. */
  async pidsOf(serial: string, packageName: string): Promise<Set<string>> {
    if (!/^[A-Za-z0-9._]+$/.test(packageName)) return new Set()
    const result = await this.runner.run([this.adb, '-s', serial, 'shell', 'pidof', packageName], 5000)
    return result.ok ? new Set(result.text.trim().split(/\s+/).filter((s) => s)) : new Set()
  }

  async devicesLongFormat(): Promise<string> {
    return (await this.runner.runChecked([this.adb, 'devices', '-l'])).text
  }

  async screencapPng(serial: string): Promise<Buffer> {
    return AdbOutput.pngFrom((await this.runner.runChecked([this.adb, '-s', serial, 'exec-out', 'screencap', '-p'], 10_000)).stdout)
  }

  async displaySize(serial: string): Promise<Size | undefined> {
    return AdbOutput.parseWmSize((await this.runner.run([this.adb, '-s', serial, 'shell', 'wm', 'size'])).text)
  }

  /** Screen density in dpi from `wm density` (an override wins), undefined when the device does not say. */
  async displayDensity(serial: string): Promise<number | undefined> {
    return AdbOutput.parseWmDensity((await this.runner.run([this.adb, '-s', serial, 'shell', 'wm', 'density'], 5000)).text)
  }

  async avdName(serial: string): Promise<string | undefined> {
    const result = await this.runner.run([this.adb, '-s', serial, 'emu', 'avd', 'name'], 5000)
    if (!result.ok) return undefined
    return result.text.split('\n').map((l) => l.trim()).find((l) => l && l !== 'OK')
  }

  async osVersion(serial: string): Promise<string | undefined> {
    const result = await this.runner.run([this.adb, '-s', serial, 'shell', 'getprop', 'ro.build.version.release'], 5000)
    const v = result.ok ? result.text.trim() : ''
    return v ? `Android ${v}` : undefined
  }

  tap(serial: string, x: number, y: number): Promise<void> {
    return this.shell(serial, 'input', 'tap', `${x}`, `${y}`)
  }

  swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    return this.shell(serial, 'input', 'swipe', `${x1}`, `${y1}`, `${x2}`, `${y2}`, `${durationMs}`)
  }

  keyEvent(serial: string, keyCode: number): Promise<void> {
    return this.shell(serial, 'input', 'keyevent', `${keyCode}`)
  }

  /** Holds the key codes together (`input keycombination`), e.g. CTRL_LEFT + A. */
  keyCombination(serial: string, ...keyCodes: number[]): Promise<void> {
    return this.shell(serial, 'input', 'keycombination', ...keyCodes.map(String))
  }

  async text(serial: string, text: string): Promise<void> {
    if (!text) return
    await this.shell(serial, 'input', 'text', AdbOutput.escapeInputText(text))
  }

  /** Returns the uiautomator XML of the current screen. */
  async dumpHierarchy(serial: string): Promise<string> {
    const remote = '/sdcard/mobiletestbench_window_dump.xml'
    const dump = await this.runner.run([this.adb, '-s', serial, 'shell', 'uiautomator', 'dump', remote], 30_000)
    if (!dump.ok || dump.text.includes('ERROR')) {
      const detail = `${dump.text.trim()} ${dump.stderr.trim()}`.trim() || `exit code ${dump.exitCode}`
      // Exit 137 (SIGKILL) is how Android 17 stops uiautomator; mobilecli reads the hierarchy another way.
      throw new Error(`uiautomator dump failed: ${detail}. Install mobilecli (npm install -g mobilecli) for the element inspector on this device.`)
    }
    return (await this.runner.runChecked([this.adb, '-s', serial, 'exec-out', 'cat', remote])).text
  }

  private async shell(serial: string, ...args: string[]): Promise<void> {
    await this.runner.runChecked([this.adb, '-s', serial, 'shell', ...args])
  }
}
