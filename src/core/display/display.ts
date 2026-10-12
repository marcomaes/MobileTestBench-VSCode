// ported-from: core/display/Display.kt
import type { Platform } from '../model'
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'

/**
 * What the Display tab can read and change. Values are the platform's raw text (for example `yes` / `no` / `auto`
 * for Android night mode); undefined means "not set" so a restore can delete the setting again instead of writing a value.
 */
export type DisplayKey =
  /** Android `cmd uimode night`, iOS `simctl ui appearance`. */
  | 'APPEARANCE'
  /** Android `font_scale`, iOS `simctl ui content_size`. */
  | 'FONT_SIZE'
  /** Android only: the three global animation scales. */
  | 'WINDOW_SCALE'
  | 'TRANSITION_SCALE'
  | 'ANIMATOR_SCALE'
  /** Android only. */
  | 'SHOW_TOUCHES'
  | 'LAYOUT_BOUNDS'
  | 'POINTER_LOCATION'
  | 'DONT_KEEP_ACTIVITIES'

export const DisplayKeys = {
  /** Declaration order of the Kotlin enum (`DisplayKey.values()`). */
  values: [
    'APPEARANCE',
    'FONT_SIZE',
    'WINDOW_SCALE',
    'TRANSITION_SCALE',
    'ANIMATOR_SCALE',
    'SHOW_TOUCHES',
    'LAYOUT_BOUNDS',
    'POINTER_LOCATION',
    'DONT_KEEP_ACTIVITIES',
  ] as readonly DisplayKey[],
  ANIMATIONS: ['WINDOW_SCALE', 'TRANSITION_SCALE', 'ANIMATOR_SCALE'] as readonly DisplayKey[],
}

/** Kotlin `String.toDoubleOrNull()`. */
function toDoubleOrNull(s: string): number | undefined {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : undefined
}

/** Kotlin `lineSequence()`: splits on \n, \r\n and \r. */
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)

const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))

/** A snapshot read from the device: the raw values that could be read, and the error text for those that could not. */
export class DisplayState {
  constructor(
    /** Key present: the value could be read; an undefined value means "not set". */
    readonly values: Map<DisplayKey, string | undefined>,
    readonly errors: Map<DisplayKey, string> = new Map(),
  ) {}

  has(key: DisplayKey): boolean {
    return this.values.has(key)
  }

  /** True when all three animation scales are 0; undefined when any of them could not be read. Unset means the default, 1. */
  get animationsOff(): boolean | undefined {
    if (DisplayKeys.ANIMATIONS.some((k) => !this.values.has(k))) return undefined
    return DisplayKeys.ANIMATIONS.every((k) => {
      const v = this.values.get(k)
      return v !== undefined && toDoubleOrNull(v) === 0
    })
  }

  get showTouches(): boolean | undefined {
    return this.values.has('SHOW_TOUCHES') ? this.values.get('SHOW_TOUCHES') === '1' : undefined
  }

  get layoutBounds(): boolean | undefined {
    return this.values.has('LAYOUT_BOUNDS') ? this.values.get('LAYOUT_BOUNDS')?.toLowerCase() === 'true' : undefined
  }

  /** `settings system pointer_location`; unset reads as off. */
  get pointerLocation(): boolean | undefined {
    return this.values.has('POINTER_LOCATION') ? this.values.get('POINTER_LOCATION') === '1' : undefined
  }

  /** `settings global always_finish_activities` ("Don't keep activities"); unset reads as off. */
  get dontKeepActivities(): boolean | undefined {
    return this.values.has('DONT_KEEP_ACTIVITIES') ? this.values.get('DONT_KEEP_ACTIVITIES') === '1' : undefined
  }
}

/** Dark mode choice. iOS has no automatic mode. */
export type Appearance = 'AUTO' | 'LIGHT' | 'DARK'

const APPEARANCE_INFO: Record<Appearance, { label: string; android: string; ios: string | undefined }> = {
  AUTO: { label: 'Auto', android: 'auto', ios: undefined },
  LIGHT: { label: 'Light', android: 'no', ios: 'light' },
  DARK: { label: 'Dark', android: 'yes', ios: 'dark' },
}

export const Appearances = {
  values: ['AUTO', 'LIGHT', 'DARK'] as readonly Appearance[],
  label: (a: Appearance): string => APPEARANCE_INFO[a].label,
  raw(a: Appearance, platform: Platform): string {
    const info = APPEARANCE_INFO[a]
    if (platform === 'ANDROID') return info.android
    if (info.ios === undefined) throw new Error(`${info.label} is not available on iOS`)
    return info.ios
  },
  /** The choices a platform offers. */
  forPlatform: (platform: Platform): Appearance[] => Appearances.values.filter((a) => platform === 'ANDROID' || APPEARANCE_INFO[a].ios !== undefined),
  /** Undefined for a value that is none of the choices (Android `custom_schedule` / `custom_bedtime`). */
  fromRaw: (platform: Platform, raw: string | undefined): Appearance | undefined =>
    Appearances.values.find((a) => (platform === 'ANDROID' ? APPEARANCE_INFO[a].android : APPEARANCE_INFO[a].ios) === raw),
}

/** Font size presets and what each platform maps them to (Android font_scale as in the Pixel settings, iOS content size category). */
export type FontPreset = 'SMALL' | 'DEFAULT' | 'LARGE' | 'LARGEST'

const FONT_INFO: Record<FontPreset, { label: string; androidScale: string; iosCategory: string }> = {
  SMALL: { label: 'Small', androidScale: '0.85', iosCategory: 'small' },
  DEFAULT: { label: 'Default', androidScale: '1.0', iosCategory: 'large' },
  LARGE: { label: 'Large', androidScale: '1.15', iosCategory: 'extra-extra-large' },
  LARGEST: { label: 'Largest', androidScale: '1.3', iosCategory: 'accessibility-extra-extra-extra-large' },
}

export const FontPresets = {
  values: ['SMALL', 'DEFAULT', 'LARGE', 'LARGEST'] as readonly FontPreset[],
  label: (p: FontPreset): string => FONT_INFO[p].label,
  raw: (p: FontPreset, platform: Platform): string => (platform === 'ANDROID' ? FONT_INFO[p].androidScale : FONT_INFO[p].iosCategory),
  /** The preset whose scale matches [raw] (an unset font_scale is the default 1.0); undefined for a custom value such as 1.5. */
  fromAndroid(raw: string | undefined): FontPreset | undefined {
    if (raw === undefined) return 'DEFAULT'
    const v = toDoubleOrNull(raw)
    if (v === undefined) return undefined
    return FontPresets.values.find((p) => Math.abs(Number(FONT_INFO[p].androidScale) - v) < 0.005)
  },
  fromIos: (raw: string | undefined): FontPreset | undefined => FontPresets.values.find((p) => FONT_INFO[p].iosCategory === raw?.toLowerCase()),
  fromRaw: (platform: Platform, raw: string | undefined): FontPreset | undefined => (platform === 'ANDROID' ? FontPresets.fromAndroid(raw) : FontPresets.fromIos(raw)),
}

/** Parsing of command output. Pure. */
export const DisplayParsers = {
  /** `cmd uimode night` prints `Night mode: no`; returns `no`, `yes`, `auto`, `custom_schedule` or `custom_bedtime`. */
  nightMode: (text: string): string | undefined => /Night mode:\s*(\S+)/.exec(text)?.[1].toLowerCase(),

  /** `settings get` and `getprop` print the literal `null` (or an empty line) for a value that was never set. */
  settingValue(text: string): string | undefined {
    const t = text.trim()
    return t.length > 0 && t !== 'null' ? t : undefined
  },

  /**
   * `simctl ui <udid> appearance|content_size` prints one word. The content size comes back with odd capitals
   * (`extra-Small`, `Small`), so it is lowercased. Undefined for `unsupported`, `unknown`, empty or a sentence (an error text).
   */
  simctlValue(text: string): string | undefined {
    const t = text.trim().toLowerCase()
    return t.length > 0 && !t.includes(' ') && t !== 'unsupported' && t !== 'unknown' ? t : undefined
  },

  /** simctl reports a bad value as `Invalid argument` (also `Unknown apperance: x`) but may still exit 0; returns that text, else undefined. */
  simctlError(text: string): string | undefined {
    const t = text.trim()
    return t.toLowerCase().includes('invalid argument') || t.toLowerCase().startsWith('unknown') ? t : undefined
  },
}

/** Reads and writes the display settings of one device. */
export interface DisplayBackend {
  readonly platform: Platform
  /** The keys this platform supports. */
  readonly keys: ReadonlySet<DisplayKey>
  read(): Promise<DisplayState>
  /** Writes the raw [value] (undefined: unset it, or the platform default). Throws with the tool's error text on failure. */
  write(key: DisplayKey, value: string | undefined): Promise<void>
}

const TIMEOUT_MS = 10_000

/** adb based backend for an Android emulator or device. */
export class AndroidDisplay implements DisplayBackend {
  readonly platform: Platform = 'ANDROID'
  readonly keys: ReadonlySet<DisplayKey> = new Set(DisplayKeys.values)

  /** The value goes through the device shell (adb joins the arguments into one command line), so only plain characters are allowed. */
  private readonly safe = /^[A-Za-z0-9._-]+$/

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  private shell(...args: string[]): string[] {
    return [this.adb, '-s', this.serial, 'shell', ...args]
  }

  readCommand(key: DisplayKey): string[] {
    switch (key) {
      case 'APPEARANCE': return this.shell('cmd', 'uimode', 'night')
      case 'FONT_SIZE': return this.shell('settings', 'get', 'system', 'font_scale')
      case 'WINDOW_SCALE': return this.shell('settings', 'get', 'global', 'window_animation_scale')
      case 'TRANSITION_SCALE': return this.shell('settings', 'get', 'global', 'transition_animation_scale')
      case 'ANIMATOR_SCALE': return this.shell('settings', 'get', 'global', 'animator_duration_scale')
      case 'SHOW_TOUCHES': return this.shell('settings', 'get', 'system', 'show_touches')
      case 'LAYOUT_BOUNDS': return this.shell('getprop', 'debug.layout')
      case 'POINTER_LOCATION': return this.shell('settings', 'get', 'system', 'pointer_location')
      case 'DONT_KEEP_ACTIVITIES': return this.shell('settings', 'get', 'global', 'always_finish_activities')
    }
  }

  /**
   * The command that writes [value] (undefined: delete the setting; night mode `auto`; layout bounds empty). Layout bounds
   * (`debug.layout`) clears with an empty value, which has to travel inside one quoted shell string: adb loses an empty argument.
   */
  writeCommand(key: DisplayKey, value: string | undefined): string[] {
    if (value !== undefined && !this.safe.test(value)) throw new Error(`Unsupported value: ${value}`)
    const setting = (namespace: string, name: string): string[] =>
      value === undefined ? this.shell('settings', 'delete', namespace, name) : this.shell('settings', 'put', namespace, name, value)
    switch (key) {
      case 'APPEARANCE': return this.shell('cmd', 'uimode', 'night', value ?? 'auto')
      case 'FONT_SIZE': return setting('system', 'font_scale')
      case 'WINDOW_SCALE': return setting('global', 'window_animation_scale')
      case 'TRANSITION_SCALE': return setting('global', 'transition_animation_scale')
      case 'ANIMATOR_SCALE': return setting('global', 'animator_duration_scale')
      case 'SHOW_TOUCHES': return setting('system', 'show_touches')
      case 'LAYOUT_BOUNDS': return this.shell(`setprop debug.layout ${value ?? "''"}`)
      case 'POINTER_LOCATION': return setting('system', 'pointer_location')
      case 'DONT_KEEP_ACTIVITIES': return setting('global', 'always_finish_activities')
    }
  }

  async read(): Promise<DisplayState> {
    const values = new Map<DisplayKey, string | undefined>()
    const errors = new Map<DisplayKey, string>()
    for (const key of this.keys) {
      try {
        const result = await this.runner.run(this.readCommand(key), TIMEOUT_MS)
        if (!result.ok) throw new CommandFailedException(this.errorText(result.text, result.stderr, result.exitCode))
        if (key === 'APPEARANCE') {
          const night = DisplayParsers.nightMode(result.text)
          if (night === undefined) throw new CommandFailedException(`Unexpected output: ${result.text.trim().slice(0, 120)}`)
          values.set(key, night)
        } else {
          values.set(key, DisplayParsers.settingValue(result.text))
        }
      } catch (e) {
        errors.set(key, messageOf(e))
      }
    }
    return new DisplayState(values, errors)
  }

  async write(key: DisplayKey, value: string | undefined): Promise<void> {
    const result = await this.runner.run(this.writeCommand(key, value), TIMEOUT_MS)
    if (!result.ok) throw new CommandFailedException(this.errorText(result.text, result.stderr, result.exitCode))
  }

  private errorText(stdout: string, stderr: string, exit: number): string {
    const text = stderr.trim() || stdout.trim()
    return (lines(text).find((l) => l.trim() !== '') ?? `adb exited with code ${exit}`).slice(0, 200)
  }
}

/** `xcrun simctl ui` backend for an iOS simulator. Only appearance and font size exist there. */
export class IosDisplay implements DisplayBackend {
  readonly platform: Platform = 'IOS'
  readonly keys: ReadonlySet<DisplayKey> = new Set<DisplayKey>(['APPEARANCE', 'FONT_SIZE'])

  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
  ) {}

  private subcommand(key: DisplayKey): string {
    return key === 'APPEARANCE' ? 'appearance' : 'content_size'
  }

  readCommand(key: DisplayKey): string[] {
    return [this.xcrun, 'simctl', 'ui', this.udid, this.subcommand(key)]
  }

  writeCommand(key: DisplayKey, value: string): string[] {
    return [this.xcrun, 'simctl', 'ui', this.udid, this.subcommand(key), value]
  }

  async read(): Promise<DisplayState> {
    const values = new Map<DisplayKey, string | undefined>()
    const errors = new Map<DisplayKey, string>()
    for (const key of this.keys) {
      try {
        const result = await this.runner.run(this.readCommand(key), TIMEOUT_MS)
        const text = result.text + result.stderr
        if (!result.ok) throw new CommandFailedException(text.trim().slice(0, 200) || `simctl exited with code ${result.exitCode}`)
        const value = DisplayParsers.simctlValue(result.text)
        if (value === undefined) throw new CommandFailedException(`Not available: ${result.text.trim().slice(0, 120) || 'no output'}`)
        values.set(key, value)
      } catch (e) {
        errors.set(key, messageOf(e))
      }
    }
    return new DisplayState(values, errors)
  }

  /** iOS has no "unset": an undefined value restores the default (light, content size large). */
  async write(key: DisplayKey, value: string | undefined): Promise<void> {
    if (!this.keys.has(key)) throw new Error(`Not supported on iOS: ${key}`)
    const v = value ?? DisplayDefaults.forPlatform('IOS').get(key)
    if (v === undefined) throw new Error('no default')
    const result = await this.runner.run(this.writeCommand(key, v), TIMEOUT_MS)
    const text = (result.text + result.stderr).trim()
    // simctl exits 0 for a bad content size and only prints "Invalid argument".
    const err = DisplayParsers.simctlError(text)
    if (err !== undefined) throw new CommandFailedException(err.slice(0, 200))
    if (!result.ok) throw new CommandFailedException(text.slice(0, 200) || `simctl exited with code ${result.exitCode}`)
  }
}

/** The values the first change of this tab replaced, per device, so Reset restores exactly what was there (including "unset"). */
export class DisplayBaseline {
  private readonly originalsByDevice = new Map<string, Map<DisplayKey, string | undefined>>()

  /** Remembers the current value of each of [keys] unless an earlier change already did. Keys that could not be read are skipped. */
  remember(deviceKey: string, current: DisplayState, keys: Iterable<DisplayKey>): void {
    let map = this.originalsByDevice.get(deviceKey)
    if (!map) this.originalsByDevice.set(deviceKey, (map = new Map()))
    for (const key of keys) if (current.values.has(key) && !map.has(key)) map.set(key, current.values.get(key))
  }

  originals(deviceKey: string): Map<DisplayKey, string | undefined> {
    return new Map(this.originalsByDevice.get(deviceKey) ?? [])
  }

  clear(deviceKey: string): void {
    this.originalsByDevice.delete(deviceKey)
  }
}

/** Outcome of [DisplayActions.reset]: [failure] is the first write error (undefined on success), [restored] tells if remembered values were used. */
export interface ResetOutcome {
  readonly failure: string | undefined
  readonly restored: boolean
}

export type DisplayChange = [DisplayKey, string | undefined]

/** Write orchestration of the Display tab: remember, write in order, stop at the first error; Reset clears the baseline only on success. */
export class DisplayActions {
  constructor(readonly baseline: DisplayBaseline = new DisplayBaseline()) {}

  /** Remembers the values [changes] replace, then writes them. Returns the first error text or undefined. */
  async change(deviceKey: string, backend: DisplayBackend, before: DisplayState, changes: DisplayChange[]): Promise<string | undefined> {
    this.baseline.remember(deviceKey, before, changes.map((c) => c[0]))
    return this.write(backend, changes)
  }

  /**
   * Restores what this tab changed, or the platform defaults when nothing was remembered. Never remembers anything itself, so a failed
   * reset leaves the baseline as it was and a second Reset tries the same plan again.
   */
  async reset(deviceKey: string, platform: Platform, backend: DisplayBackend): Promise<ResetOutcome> {
    const originals = this.baseline.originals(deviceKey)
    const failure = await this.write(backend, DisplayDefaults.resetPlan(platform, originals))
    if (failure === undefined) this.baseline.clear(deviceKey)
    return { failure, restored: originals.size > 0 }
  }

  private async write(backend: DisplayBackend, changes: DisplayChange[]): Promise<string | undefined> {
    for (const [key, value] of changes) {
      try {
        await backend.write(key, value)
      } catch (e) {
        return messageOf(e)
      }
    }
    return undefined
  }
}

export const DisplayDefaults = {
  /** Platform defaults used by Reset when this tab has not changed anything yet. Undefined: unset (Android). */
  forPlatform(platform: Platform): Map<DisplayKey, string | undefined> {
    return platform === 'ANDROID'
      ? new Map<DisplayKey, string | undefined>([
          ['APPEARANCE', 'auto'],
          ['FONT_SIZE', '1.0'],
          ['WINDOW_SCALE', undefined],
          ['TRANSITION_SCALE', undefined],
          ['ANIMATOR_SCALE', undefined],
          ['SHOW_TOUCHES', undefined],
          ['LAYOUT_BOUNDS', undefined],
          ['POINTER_LOCATION', undefined],
          ['DONT_KEEP_ACTIVITIES', undefined],
        ])
      : new Map<DisplayKey, string | undefined>([
          ['APPEARANCE', 'light'],
          ['FONT_SIZE', 'large'],
        ])
  },

  /** What Reset writes: the remembered originals, or the platform defaults when nothing was changed. */
  resetPlan(platform: Platform, originals: Map<DisplayKey, string | undefined>): DisplayChange[] {
    return [...(originals.size > 0 ? originals : DisplayDefaults.forPlatform(platform))]
  },
}
