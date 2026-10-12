// ported-from: core/ios/MobilecliClient.kt
import type { ChildProcess } from 'node:child_process'
import type { Device } from '../model'
import type { AdbClient } from '../android/adbClient'
import type { CommandRunner } from '../exec/commandRunner'
import { MobilecliException, MobilecliJson } from '../mobilecliJson'

/**
 * Thin wrapper around the `mobilecli` CLI (https://github.com/mobile-next/mobilecli). Used for iOS devices and
 * simulators, and as Android hierarchy fallback. Every call is one process; failures surface as CommandFailedException
 * (mobilecli exits 1 and prints the reason on stderr). Coordinates are iOS points, the same space `dump ui` reports.
 */
export class MobilecliClient {
  constructor(
    private readonly executable: string,
    private readonly runner: CommandRunner,
  ) {}

  async realIosDevicesJson(): Promise<string> {
    return (await this.run(['devices', '--platform', 'ios', '--type', 'real'])).text
  }

  /** Also lists stopped AVDs and shut-down simulators (state "offline"). */
  async devicesIncludingOfflineJson(): Promise<string> {
    return (await this.run(['devices', '--include-offline'])).text
  }

  async deviceInfoJson(id: string): Promise<string> {
    return (await this.run(['device', 'info', '--device', id])).text
  }

  async screenshotPng(id: string): Promise<Buffer> {
    return (await this.run(['screenshot', '--device', id, '-o', '-'], 15_000)).stdout
  }

  async dumpUiJson(id: string): Promise<string> {
    return (await this.run(['dump', 'ui', '--device', id], 60_000)).text
  }

  /** Android: the agent's unprocessed tree (class, text, content-desc, resource-id, rect, ...). */
  async dumpUiRawJson(id: string): Promise<string> {
    return (await this.run(['dump', 'ui', '--device', id, '--format', 'raw'], 60_000)).text
  }

  async tap(id: string, x: number, y: number): Promise<void> {
    await this.run(['io', 'tap', '--device', id, `${x},${y}`])
  }

  async swipe(id: string, fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    await this.run(['io', 'swipe', '--device', id, '--duration', String(durationMs), `${fromX},${fromY},${toX},${toY}`])
  }

  /** Holds for [durationMs], then returns. There is no mobilecli command for double tap or gestures. */
  async longPress(id: string, x: number, y: number, durationMs: number): Promise<void> {
    await this.run(['io', 'longpress', '--device', id, '--duration', String(durationMs), `${x},${y}`], durationMs + 20_000)
  }

  /**
   * Presses a hardware button. The name must be UPPER CASE on both platforms (mobilecli 1.0.17 rejects lower case
   * although its help says otherwise). Android accepts HOME, BACK, APP_SWITCH, POWER, VOLUME_UP, VOLUME_DOWN, ENTER; iOS
   * simulators accept HOME, VOLUME_UP, VOLUME_DOWN, LOCK (a toggle; there is no POWER). Throws MobilecliException with
   * mobilecli's text for an unsupported name.
   */
  button(id: string, name: string): Promise<void> {
    return this.keyCall(['io', 'button', '--device', id, name])
  }

  /** The clipboard text (empty when it is empty). Works on Android and iOS. */
  async clipboardGet(id: string): Promise<string> {
    const data = MobilecliJson.data(await this.call(id, ['io', 'clipboard', 'get']))
    const text = data && typeof data === 'object' ? (data as { text?: unknown }).text : undefined
    return typeof text === 'string' ? text : ''
  }

  /** Sets the clipboard ("" clears it). The text travels as one argument, so no shell quoting applies. */
  async clipboardSet(id: string, text: string): Promise<void> {
    // Text that starts with "-" would be read as a flag; "--" ends the flags (the same form `io text` uses).
    const args = text.startsWith('-') ? ['io', 'clipboard', 'set', '--device', id, '--', text] : ['io', 'clipboard', 'set', '--device', id, text]
    const result = await this.runner.run([this.executable, ...args], 20_000)
    if (!result.ok || MobilecliJson.isError(result.text)) throw new MobilecliException(MobilecliJson.errorMessage(result.text, result.stderr))
  }

  /** key: a mobilecli key combo such as "enter" or "backspace". */
  key(id: string, key: string): Promise<void> {
    return this.keyCall(['io', 'keys', '--device', id, key])
  }

  /** Several combos in one call; each is its own argument. A bad name fails the whole call before anything is pressed. */
  keys(id: string, keys: string[]): Promise<void> {
    return this.keyCall(['io', 'keys', '--device', id, ...keys])
  }

  /** `io keys` and `io button` report a bad name as a JSON error envelope on stdout (exit 1, empty stderr): surface that text. */
  private async keyCall(args: string[]): Promise<void> {
    const result = await this.runner.run([this.executable, ...args], 20_000)
    if (!result.ok || MobilecliJson.isError(result.text)) throw new MobilecliException(MobilecliJson.errorMessage(result.text, result.stderr))
  }

  async text(id: string, text: string): Promise<void> {
    await this.run(['io', 'text', '--device', id, '--', text])
  }

  /** Command line of a screen recording to an MP4 file (long running; stop it by ending the process). */
  screenRecordCommand(id: string, output: string): string[] {
    return [this.executable, 'screenrecord', '--device', id, '-o', output, '--silent']
  }

  /** Command line of the live device log (JSON lines, long running). No `--filter`: its filters are exact equality and hang when nothing matches. */
  logsCommand(id: string): string[] {
    return [this.executable, 'device', 'logs', '--device', id]
  }

  /** Command line of the MJPEG screen stream (long running, started by the caller). */
  screenStreamCommand(id: string): string[] {
    return [this.executable, 'screencapture', '--device', id, '-f', 'mjpeg']
  }

  /** Starts the MJPEG screen stream process; the caller reads its stdout and ends it with `kill`. */
  startScreenStream(id: string): ChildProcess {
    return this.runner.start(this.screenStreamCommand(id))
  }

  /**
   * Generic call for features: runs `mobilecli <args> --device <id>` and returns stdout (usually the JSON envelope).
   * Throws MobilecliException with mobilecli's own error text when it fails (error envelope, non zero exit, or an error
   * envelope with exit 0).
   */
  async call(id: string, args: string[], timeoutMs = 20_000): Promise<string> {
    const result = await this.runner.run(MobilecliJson.commandLine(this.executable, id, args), timeoutMs)
    const stdout = result.text
    if (!result.ok || MobilecliJson.isError(stdout)) throw new MobilecliException(MobilecliJson.errorMessage(stdout, result.stderr))
    return stdout
  }

  private run(args: string[], timeoutMs = 20_000) {
    return this.runner.runChecked([this.executable, ...args], timeoutMs)
  }

  /** mobilecli names an Android emulator by its AVD name, not by the adb serial; everything else by the device id. */
  static async idFor(device: Device, adb: AdbClient): Promise<string> {
    return device.id.startsWith('emulator-') ? ((await adb.avdName(device.id)) ?? device.id) : device.id
  }
}
