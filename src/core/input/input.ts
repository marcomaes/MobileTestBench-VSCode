// ported-from: core/input/Input.kt
import type { Platform } from '../model'
import type { CommandRunner } from '../exec/commandRunner'
import type { MobilecliClient } from '../ios/mobilecliClient'

/**
 * Hardware buttons of the Input tab. A separate type from `DeviceKey` on purpose: the recorder and player use `DeviceKey`, and nothing
 * here may be recorded without a player mapping. Names are mobilecli's (UPPER CASE only) and were verified on an Android emulator and an
 * iOS simulator with mobilecli 1.0.17.
 */
export type HardwareButton = 'VOLUME_UP' | 'VOLUME_DOWN' | 'HOME' | 'POWER' | 'BACK' | 'APP_SWITCH' | 'ASSISTANT' | 'SHAKE'

interface HardwareButtonInfo {
  readonly label: string
  /** mobilecli button name on Android, undefined when mobilecli has none (the adb key code is used). */
  readonly androidName: string | undefined
  /** adb key code; undefined when the button does not exist on Android. */
  readonly androidKeyCode: number | undefined
  /** mobilecli button name on iOS simulators; undefined when the button does not exist there. */
  readonly iosName: string | undefined
  readonly androidHint: string
  readonly iosHint: string
}

const PANEL_HINT = 'The first press while the volume panel is hidden may only show the panel'
const NOT_OBSERVABLE = 'Pressed, but the effect is not observable from here'

const HARDWARE: Record<HardwareButton, HardwareButtonInfo> = {
  VOLUME_UP: { label: 'Volume up', androidName: 'VOLUME_UP', androidKeyCode: 24, iosName: 'VOLUME_UP', androidHint: PANEL_HINT, iosHint: NOT_OBSERVABLE },
  VOLUME_DOWN: { label: 'Volume down', androidName: 'VOLUME_DOWN', androidKeyCode: 25, iosName: 'VOLUME_DOWN', androidHint: PANEL_HINT, iosHint: NOT_OBSERVABLE },
  HOME: { label: 'Home', androidName: 'HOME', androidKeyCode: 3, iosName: 'HOME', androidHint: '', iosHint: '' },
  POWER: {
    label: 'Power / Lock',
    androidName: 'POWER',
    androidKeyCode: 26,
    iosName: 'LOCK',
    androidHint: 'Toggles: sleeps the screen, a second press wakes it',
    iosHint: 'Lock toggles; wake with it, then press Home to unlock',
  },
  BACK: { label: 'Back', androidName: 'BACK', androidKeyCode: 4, iosName: undefined, androidHint: '', iosHint: 'Android only' },
  APP_SWITCH: { label: 'App switch', androidName: 'APP_SWITCH', androidKeyCode: 187, iosName: undefined, androidHint: '', iosHint: 'Android only' },
  ASSISTANT: {
    label: 'Assistant',
    androidName: undefined,
    androidKeyCode: 219,
    iosName: undefined,
    androidHint: 'The assistant overlay appears after a few seconds, if the Google app is present',
    iosHint: 'Android only (Siri has no simulator command)',
  },
  SHAKE: {
    label: 'Shake',
    androidName: undefined,
    androidKeyCode: undefined,
    iosName: undefined,
    androidHint: 'iOS simulators only',
    iosHint: 'Sends the simulator shake; an app that handles it reacts (for example Undo Typing)',
  },
}

export const HardwareButtons = {
  /** Declaration order of the Kotlin enum. */
  values: ['VOLUME_UP', 'VOLUME_DOWN', 'HOME', 'POWER', 'BACK', 'APP_SWITCH', 'ASSISTANT', 'SHAKE'] as readonly HardwareButton[],
  label: (b: HardwareButton): string => HARDWARE[b].label,
  androidName: (b: HardwareButton): string | undefined => HARDWARE[b].androidName,
  androidKeyCode: (b: HardwareButton): number | undefined => HARDWARE[b].androidKeyCode,
  iosName: (b: HardwareButton): string | undefined => HARDWARE[b].iosName,

  supports: (b: HardwareButton, platform: Platform): boolean =>
    platform === 'ANDROID' ? HARDWARE[b].androidKeyCode !== undefined : HARDWARE[b].iosName !== undefined || b === 'SHAKE',

  hint: (b: HardwareButton, platform: Platform): string => (platform === 'ANDROID' ? HARDWARE[b].androidHint : HARDWARE[b].iosHint),

  /** mobilecli's name for this button on [platform], or undefined when mobilecli cannot press it there. */
  mobilecliName: (b: HardwareButton, platform: Platform): string | undefined => (platform === 'ANDROID' ? HARDWARE[b].androidName : HARDWARE[b].iosName),

  forPlatform: (platform: Platform): HardwareButton[] => HardwareButtons.values.filter((b) => HardwareButtons.supports(b, platform)),

  /** The Android key code of the wake key (there is no mobilecli name for it). */
  ANDROID_WAKEUP: 224,
  ANDROID_ESCAPE: 111,
  SHAKE_NOTIFICATION: 'com.apple.UIKit.SimulatorShake',
}

/** Special keys. [mobilecli] is the name `mobilecli io keys` takes (arrows are plain up/down/left/right, not arrowup); [androidKeyCode] is the adb fallback. */
export type InputKey = 'TAB' | 'ESCAPE' | 'ENTER' | 'BACKSPACE' | 'DELETE' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'

const KEYS: Record<InputKey, { label: string; mobilecli: string; androidKeyCode: number }> = {
  TAB: { label: 'Tab', mobilecli: 'tab', androidKeyCode: 61 },
  ESCAPE: { label: 'Esc', mobilecli: 'escape', androidKeyCode: 111 },
  ENTER: { label: 'Enter', mobilecli: 'enter', androidKeyCode: 66 },
  BACKSPACE: { label: 'Backspace', mobilecli: 'backspace', androidKeyCode: 67 },
  DELETE: { label: 'Delete', mobilecli: 'delete', androidKeyCode: 112 },
  UP: { label: 'Up', mobilecli: 'up', androidKeyCode: 19 },
  DOWN: { label: 'Down', mobilecli: 'down', androidKeyCode: 20 },
  LEFT: { label: 'Left', mobilecli: 'left', androidKeyCode: 21 },
  RIGHT: { label: 'Right', mobilecli: 'right', androidKeyCode: 22 },
}

export const InputKeys = {
  values: ['TAB', 'ESCAPE', 'ENTER', 'BACKSPACE', 'DELETE', 'UP', 'DOWN', 'LEFT', 'RIGHT'] as readonly InputKey[],
  label: (k: InputKey): string => KEYS[k].label,
  mobilecli: (k: InputKey): string => KEYS[k].mobilecli,
  androidKeyCode: (k: InputKey): number => KEYS[k].androidKeyCode,
}

export class Volume {
  constructor(
    readonly level: number,
    readonly min: number | undefined,
    readonly max: number | undefined,
  ) {}
  toString(): string {
    return this.max !== undefined ? `${this.level}/${this.max}` : `${this.level}`
  }
}

/** Parsers for the read-backs shown after an action. They work on the full command output. */
export const InputParsers = {
  /** `Awake`, `Asleep` or `Dozing` from `dumpsys power`. */
  wakefulness: (dumpsysPower: string): string | undefined => /mWakefulness=(\w+)/.exec(dumpsysPower)?.[1],

  /** From `cmd media_session volume --stream 3 --get` (`[V] volume is 5 in range [0..15]`), else a `streamVolume:5` line of `dumpsys audio`. */
  volume(output: string): Volume | undefined {
    const m = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(output)
    if (m) return new Volume(Number(m[1]), Number(m[2]), Number(m[3]))
    const s = /streamVolume:(\d+)/.exec(output)
    return s ? new Volume(Number(s[1]), undefined, undefined) : undefined
  },

  /** True when the soft keyboard window is visible (`mImeWindowVis` is not 0). `mInputShown` is not reliable. Undefined when the line is missing. */
  imeVisible(dumpsysInputMethod: string): boolean | undefined {
    const m = /mImeWindowVis=(0x)?([0-9a-fA-F]+)/.exec(dumpsysInputMethod)
    if (!m) return undefined
    return parseInt(m[2], m[1] ? 16 : 10) !== 0
  },

  /** True when the simulator is locked (`notifyutil -g com.apple.springboard.lockstate` prints `... lockstate 1`). */
  locked(notifyutil: string): boolean | undefined {
    const m = /lockstate\s+(\d+)/.exec(notifyutil)
    return m ? m[1] !== '0' : undefined
  },
}

const CLIPBOARD_NEEDS_MOBILECLI =
  'Clipboard needs mobilecli (adb cannot read or set the clipboard on recent Android versions; simctl pbcopy did not work on the tested simulator)'

/**
 * Runs the Input tab actions for one device. Every method returns the exact result text to show and throws
 * with the tool's own message on failure. [mobilecli] and [mobilecliId] are undefined when mobilecli is not installed: Android buttons and keys
 * then use adb key events, everything else says that it needs mobilecli.
 */
export class InputActions {
  static readonly CLIPBOARD_NEEDS_MOBILECLI = CLIPBOARD_NEEDS_MOBILECLI

  constructor(
    private readonly platform: Platform,
    private readonly deviceId: string,
    private readonly runner: CommandRunner,
    private readonly adb: string | undefined,
    private readonly xcrun: string | undefined,
    private readonly mobilecli: MobilecliClient | undefined,
    private readonly mobilecliId: string | undefined,
  ) {}

  get hasMobilecli(): boolean {
    return this.mobilecli !== undefined && this.mobilecliId !== undefined
  }

  private adbShell(...args: string[]) {
    if (this.adb === undefined) throw new Error('adb is not available')
    return this.runner.runChecked([this.adb, '-s', this.deviceId, 'shell', ...args])
  }

  private async keyEvent(code: number): Promise<void> {
    await this.adbShell('input', 'keyevent', `${code}`)
  }

  async press(button: HardwareButton): Promise<string> {
    if (!HardwareButtons.supports(button, this.platform)) {
      throw new Error(`${HardwareButtons.label(button)} is not available on ${this.platform === 'ANDROID' ? 'Android' : 'iOS'}`)
    }
    if (button === 'SHAKE') {
      if (this.xcrun === undefined) throw new Error('xcrun is not available')
      await this.runner.runChecked([this.xcrun, 'simctl', 'spawn', this.deviceId, 'notifyutil', '-p', HardwareButtons.SHAKE_NOTIFICATION])
      return 'Sent the shake gesture'
    }
    const name = HardwareButtons.mobilecliName(button, this.platform)
    if (this.platform === 'ANDROID') {
      const code = HardwareButtons.androidKeyCode(button)!
      if (name !== undefined && this.hasMobilecli) await this.mobilecli!.button(this.mobilecliId!, name)
      else await this.keyEvent(code)
      return `Pressed ${name ?? `KEYCODE ${code}`}`
    }
    if (!this.hasMobilecli) throw new Error('Hardware buttons on iOS need mobilecli')
    await this.mobilecli!.button(this.mobilecliId!, name!)
    return `Pressed ${name}`
  }

  /** Android only: the wake key, so a sleeping screen can be woken deterministically (the Power button toggles). */
  async wake(): Promise<string> {
    await this.keyEvent(HardwareButtons.ANDROID_WAKEUP)
    return 'Sent WAKEUP'
  }

  async pressKey(key: InputKey): Promise<string> {
    if (this.hasMobilecli) await this.mobilecli!.keys(this.mobilecliId!, [InputKeys.mobilecli(key)])
    else if (this.platform === 'ANDROID') await this.keyEvent(InputKeys.androidKeyCode(key))
    else throw new Error('Keys on iOS need mobilecli')
    return `Pressed ${InputKeys.mobilecli(key)}`
  }

  /** Android: hides the soft keyboard with Escape (never Back, which leaves the screen) when it is visible. */
  async hideKeyboard(): Promise<string> {
    if (this.platform !== 'ANDROID') throw new Error('Hiding the keyboard is only supported on Android')
    const visible = InputParsers.imeVisible((await this.adbShell('dumpsys', 'input_method')).text)
    if (visible === false) return 'The keyboard is not shown'
    await this.keyEvent(HardwareButtons.ANDROID_ESCAPE)
    return 'Sent Escape' + (visible === undefined ? ' (could not tell whether the keyboard was shown)' : '')
  }

  /** True/false when the keyboard state can be read (Android), undefined otherwise. */
  async keyboardVisible(): Promise<boolean | undefined> {
    return this.platform === 'ANDROID' ? InputParsers.imeVisible((await this.adbShell('dumpsys', 'input_method')).text) : undefined
  }

  /** What the device reports after a button press: wakefulness and media volume on Android, the lock state on a simulator. Undefined when nothing can be read. */
  async status(): Promise<string | undefined> {
    if (this.platform === 'ANDROID') {
      const awake = InputParsers.wakefulness((await this.adbShell('dumpsys', 'power')).text)
      const volume = InputParsers.volume((await this.adbShell('cmd', 'media_session', 'volume', '--stream', '3', '--get')).text)
      const parts = [awake !== undefined ? `screen ${awake}` : undefined, volume !== undefined ? `media volume ${volume}` : undefined].filter((p): p is string => p !== undefined)
      return parts.length > 0 ? parts.join(', ') : undefined
    }
    if (this.xcrun !== undefined) {
      const out = await this.runner.run([this.xcrun, 'simctl', 'spawn', this.deviceId, 'notifyutil', '-g', 'com.apple.springboard.lockstate'])
      const locked = InputParsers.locked(out.text)
      return locked === undefined ? undefined : locked ? 'locked' : 'unlocked'
    }
    return undefined
  }

  async clipboardGet(): Promise<string> {
    return this.requireMobilecli().clipboardGet(this.mobilecliId!)
  }

  async clipboardSet(text: string): Promise<string> {
    await this.requireMobilecli().clipboardSet(this.mobilecliId!, text)
    return text.length === 0 ? 'Clipboard cleared' : `Clipboard set (${text.length} characters)`
  }

  /** Sets the clipboard, then presses the paste combo: ctrl+v on Android, cmd+v on iOS (which shows an Allow Paste prompt on the device). */
  async setAndPaste(text: string): Promise<string> {
    await this.clipboardSet(text)
    await this.mobilecli!.keys(this.mobilecliId!, [this.platform === 'ANDROID' ? 'ctrl+v' : 'cmd+v'])
    return this.platform === 'ANDROID'
      ? 'Clipboard set and paste pressed'
      : 'Clipboard set and paste pressed. Tap Allow Paste in the dialog on the device; the plugin cannot confirm the paste'
  }

  private requireMobilecli(): MobilecliClient {
    if (!this.hasMobilecli) throw new Error(CLIPBOARD_NEEDS_MOBILECLI)
    return this.mobilecli!
  }
}
