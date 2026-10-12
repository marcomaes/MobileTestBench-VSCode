// ported-from: core/display/Locale.kt
import type { Platform } from '../model'
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'
import { DisplayParsers } from './display'

const TIMEOUT_MS = 10_000
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)
const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]))

/** Preset choices of the Language and Time zone combos. */
export const LocalePresets = {
  LANGUAGES: ['en-US', 'nl-NL', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'ar-SA'] as readonly string[],
  TIME_ZONES: ['Europe/Amsterdam', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney'] as readonly string[],

  /** Combo text for a language preset; the tag itself is what is applied. */
  languageLabel: (tag: string): string => (tag === 'ar-SA' ? 'ar-SA (right-to-left)' : tag),
}

// language [-script] [-region] [-variant]* [-singleton-ext]*, e.g. en, nl-NL, zh-Hans-CN, sr-Latn-RS, ar-SA-u-nu-latn.
const BCP47 = /^(?:[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[A-WY-Za-wy-z0-9](?:-[A-Za-z0-9]{2,8})+)*)$/

let knownZones: Set<string> | undefined
const zones = (): Set<string> => (knownZones ??= new Set((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []))

/**
 * The JDK's list of zone ids (ZoneId.getAvailableZoneIds) has no JS counterpart. Differs from Kotlin: an id is known when it is in
 * Intl.supportedValuesOf('timeZone') or when Intl accepts it and it is written with capitalised segments (Intl ignores case, the JDK does not).
 */
function isKnownZone(id: string): boolean {
  if (id === 'UTC' || zones().has(id)) return true
  if (!/^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/.test(id)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: id })
    return true
  } catch {
    return false
  }
}

/** Shape checks for what the user types. Pure. */
export const LocaleValidation = {
  /** Undefined when [tag] has the shape of a BCP 47 language tag, else the reason. The device may still not know the language. */
  languageError(tag: string): string | undefined {
    if (tag.trim() === '') return 'Enter a language tag such as nl-NL'
    if (tag.includes(',')) return 'Enter one language tag only (no comma); Android keeps a single system language this way'
    if (!BCP47.test(tag.trim())) return `"${tag.trim()}" is not a BCP 47 language tag (examples: en-US, nl-NL, zh-Hans-CN)`
    return undefined
  },

  /** Undefined when [id] is a known IANA time zone id. */
  timeZoneError(id: string): string | undefined {
    const t = id.trim()
    if (t === '') return 'Enter an IANA time zone id such as Europe/Amsterdam'
    if (t !== 'UTC' && !t.includes('/')) return `"${t}" is not an IANA time zone id (Area/City, for example Asia/Tokyo, or UTC)`
    if (!isKnownZone(t)) return `Unknown time zone id "${t}"`
    return undefined
  },
}

/** Parsing and normalisation of command output. Pure. */
export const LocaleParsers = {
  /** `settings get system system_locales` prints `en-US,nl-NL`, or `null` when unset. */
  androidLanguages: (text: string): string[] =>
    DisplayParsers.settingValue(text)
      ?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [],

  /** `cmd locale get-device-locale` prints one tag (`en-US`), or an error line. Undefined when it is not a tag. */
  deviceLocale(text: string): string | undefined {
    const t = text.trim()
    return t.length > 0 && !t.includes(' ') && LocaleValidation.languageError(t) === undefined ? t : undefined
  },

  /** `cmd locale get-app-locales <pkg>` prints `Locales for <pkg> for user 0 are [nl-NL]`; empty list when unset, undefined for anything else. */
  appLocales(text: string): string[] | undefined {
    const m = /\[([^\]]*)]/.exec(text)
    if (!m) return undefined
    return m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  },

  /** The error line of a `cmd` call, which exits 0 even for bad input; undefined when the output looks fine. */
  commandError(text: string): string | undefined {
    const hit = lines(text)
      .map((l) => l.trim())
      .find((l) => {
        const lower = l.toLowerCase()
        return lower.startsWith('error') || lower.startsWith('unknown') || l.includes('Exception') || lower.startsWith('invalid')
      })
    return hit?.slice(0, 200)
  },

  /** `defaults read -g AppleLanguages` prints a plist list: `(`, quoted or bare items one per line, `)`. */
  iosLanguages: (text: string): string[] =>
    lines(text)
      .map((l) => {
        const t = l.trim().replace(/,+$/, '').trim()
        return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
      })
      .filter((s) => s.length > 0 && s !== '(' && s !== ')'),

  /** `defaults read -g AppleLocale` prints `en_NL`. */
  iosLocale(text: string): string | undefined {
    const t = text.trim()
    return t.length > 0 && !t.includes(' ') ? t : undefined
  },

  /** `en_US` (dumpsys, AppleLocale) to `en-US`. */
  toHyphen: (tag: string): string => tag.replace(/_/g, '-'),

  /** iOS AppleLocale form of a language tag: language and region only, joined with an underscore (`zh-Hans-CN` gives `zh_CN`). */
  toIosLocale(tag: string): string {
    const parts = tag.trim().split('-')
    const region = parts.slice(1).find((p) => (p.length === 2 && /^\p{L}+$/u.test(p)) || (p.length === 3 && /^\d+$/.test(p)))
    return region === undefined ? parts[0].toLowerCase() : parts[0].toLowerCase() + '_' + region.toUpperCase()
  },

  /** The list for `AppleLanguages`: [tag] first, then the existing languages without a duplicate of it. */
  iosLanguageList: (tag: string, existing: readonly string[]): string[] => [tag.trim(), ...existing.filter((l) => l.toLowerCase() !== tag.trim().toLowerCase())],

  /** A plist array literal for `defaults write`, for example `("fr-FR","en-NL")`. */
  plistArray: (items: readonly string[]): string => '(' + items.map((i) => `"${i}"`).join(',') + ')',
}

/** What a locale read found. [timeZone] is the device's id (iOS: the Mac's, see [timeZoneFollowsHost]). Errors are per part. */
export class LocaleState {
  constructor(
    readonly languages: string[] | undefined,
    readonly appleLocale: string | undefined,
    readonly timeZone: string | undefined,
    readonly languageError: string | undefined = undefined,
    readonly timeZoneError: string | undefined = undefined,
    readonly timeZoneFollowsHost: boolean = false,
  ) {}

  get primary(): string | undefined {
    return this.languages?.[0]
  }
}

/** What the first language / time zone change per device replaced, so Reset can put it back. */
export interface LocaleBaselineEntry {
  readonly languages?: string[]
  readonly appleLocale?: string
  readonly languageChanged: boolean
  readonly timeZone?: string
  readonly timeZoneChanged: boolean
}

/** Reads and writes language and time zone of one device. Writes verify by reading back and throw on mismatch. */
export interface LocaleBackend {
  readonly platform: Platform
  readonly canSetTimeZone: boolean
  read(): Promise<LocaleState>
  /** Sets the system language to [tag]. Throws with the tool's text (or the mismatch) on failure. */
  setLanguage(tag: string, current: LocaleState): Promise<void>
  setTimeZone(id: string): Promise<void>
  /** Puts the language back to what [baseline] captured. */
  restoreLanguage(baseline: LocaleBaselineEntry): Promise<void>
}

/** adb based backend (Android 17 `cmd locale`, `cmd alarm`; older Android versions are unverified). */
export class AndroidLocale implements LocaleBackend {
  readonly platform: Platform = 'ANDROID'
  readonly canSetTimeZone = true

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  private shell(...args: string[]): string[] {
    return [this.adb, '-s', this.serial, 'shell', ...args]
  }

  readLanguagesCommand = (): string[] => this.shell('settings', 'get', 'system', 'system_locales')
  readDeviceLocaleCommand = (): string[] => this.shell('cmd', 'locale', 'get-device-locale')
  readTimeZoneCommand = (): string[] => this.shell('getprop', 'persist.sys.timezone')
  setLanguageCommand = (tag: string): string[] => this.shell('cmd', 'locale', 'set-device-locale', tag)
  setTimeZoneCommand = (id: string): string[] => this.shell('cmd', 'alarm', 'set-timezone', id)

  private async text(command: string[]): Promise<string> {
    const r = await this.runner.run(command, TIMEOUT_MS)
    const all = r.text + r.stderr
    if (!r.ok) throw new CommandFailedException((lines(all.trim()).find((l) => l.trim() !== '') ?? `adb exited with code ${r.exitCode}`).slice(0, 200))
    return r.text
  }

  async read(): Promise<LocaleState> {
    let languages: string[] | undefined
    let langErr: string | undefined
    try {
      languages = LocaleParsers.androidLanguages(await this.text(this.readLanguagesCommand()))
      if (languages.length === 0) {
        // Unset list: fall back to the primary locale (Android 17 only).
        const device = LocaleParsers.deviceLocale(await this.text(this.readDeviceLocaleCommand()).catch(() => ''))
        languages = device !== undefined ? [device] : []
      }
    } catch (e) {
      langErr = messageOf(e)
    }
    let tz: string | undefined
    let tzErr: string | undefined
    try {
      tz = DisplayParsers.settingValue(await this.text(this.readTimeZoneCommand()))
    } catch (e) {
      tzErr = messageOf(e)
    }
    return new LocaleState(languages, undefined, tz, langErr, tzErr)
  }

  async setLanguage(tag: string, _current: LocaleState): Promise<void> {
    const invalid = LocaleValidation.languageError(tag)
    if (invalid !== undefined) throw new Error(invalid)
    const r = await this.runner.run(this.setLanguageCommand(tag.trim()), TIMEOUT_MS)
    const out = (r.text + r.stderr).trim()
    // The cmd tool exits 0 for bad input, so the text is checked as well.
    const err = LocaleParsers.commandError(out)
    if (err !== undefined) throw new CommandFailedException(err)
    if (!r.ok) throw new CommandFailedException(out.slice(0, 200) || `adb exited with code ${r.exitCode}`)
    const now = LocaleParsers.deviceLocale(await this.text(this.readDeviceLocaleCommand()))
    if (now === undefined || now.toLowerCase() !== tag.trim().toLowerCase()) {
      throw new CommandFailedException(`The device reports ${now ?? 'no locale'} instead of ${tag.trim()} (the device may not know that language)`)
    }
  }

  async setTimeZone(id: string): Promise<void> {
    const invalid = LocaleValidation.timeZoneError(id)
    if (invalid !== undefined) throw new Error(invalid)
    const r = await this.runner.run(this.setTimeZoneCommand(id.trim()), TIMEOUT_MS)
    const out = (r.text + r.stderr).trim()
    const err = LocaleParsers.commandError(out)
    if (err !== undefined) throw new CommandFailedException(err)
    if (!r.ok) throw new CommandFailedException(out.slice(0, 200) || `adb exited with code ${r.exitCode}`)
    // An id the device does not know is ignored silently, so read it back.
    const now = DisplayParsers.settingValue(await this.text(this.readTimeZoneCommand()))
    if (now !== id.trim()) throw new CommandFailedException(`The device reports ${now ?? 'no time zone'} instead of ${id.trim()}`)
  }

  /** Only the first language comes back: `set-device-locale` takes one tag and replaces the whole list. */
  async restoreLanguage(baseline: LocaleBaselineEntry): Promise<void> {
    const first = baseline.languages?.[0]
    if (first === undefined) return
    await this.setLanguage(first, new LocaleState(undefined, undefined, undefined))
  }
}

/** iOS simulator backend: `simctl spawn <udid> defaults` on the global domain. The time zone is the Mac's and cannot be set. */
export class IosLocale implements LocaleBackend {
  readonly platform: Platform = 'IOS'
  readonly canSetTimeZone = false

  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
    private readonly hostZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  private defaults(...args: string[]): string[] {
    return [this.xcrun, 'simctl', 'spawn', this.udid, 'defaults', ...args]
  }

  readCommand = (key: string): string[] => this.defaults('read', '-g', key)
  writeLanguagesCommand = (list: readonly string[]): string[] => this.defaults('write', '-g', 'AppleLanguages', LocaleParsers.plistArray(list))
  writeLocaleCommand = (locale: string): string[] => this.defaults('write', '-g', 'AppleLocale', locale)
  deleteCommand = (key: string): string[] => this.defaults('delete', '-g', key)

  /** Undefined for a key that does not exist (defaults exits non zero with "does not exist"). */
  private async readKey(key: string): Promise<string | undefined> {
    const r = await this.runner.run(this.readCommand(key), TIMEOUT_MS)
    const all = r.text + r.stderr
    if (!r.ok) {
      if (all.includes('does not exist')) return undefined
      throw new CommandFailedException(all.trim().slice(0, 200) || `defaults exited with code ${r.exitCode}`)
    }
    return r.text
  }

  private async run(command: string[]): Promise<void> {
    const r = await this.runner.run(command, TIMEOUT_MS)
    if (!r.ok) throw new CommandFailedException((r.text + r.stderr).trim().slice(0, 200) || `defaults exited with code ${r.exitCode}`)
  }

  async read(): Promise<LocaleState> {
    let languages: string[] | undefined
    let locale: string | undefined
    let err: string | undefined
    try {
      const raw = await this.readKey('AppleLanguages')
      languages = raw !== undefined ? LocaleParsers.iosLanguages(raw) : []
      const rawLocale = await this.readKey('AppleLocale')
      locale = rawLocale !== undefined ? LocaleParsers.iosLocale(rawLocale) : undefined
    } catch (e) {
      err = messageOf(e)
    }
    return new LocaleState(languages, locale, this.hostZone(), err, undefined, true)
  }

  async setLanguage(tag: string, current: LocaleState): Promise<void> {
    const invalid = LocaleValidation.languageError(tag)
    if (invalid !== undefined) throw new Error(invalid)
    const list = LocaleParsers.iosLanguageList(tag, current.languages ?? [])
    await this.run(this.writeLanguagesCommand(list))
    await this.run(this.writeLocaleCommand(LocaleParsers.toIosLocale(tag)))
    const back = LocaleParsers.iosLanguages((await this.readKey('AppleLanguages')) ?? '')
    if (back[0] !== tag.trim()) throw new CommandFailedException(`The simulator reports ${back[0] ?? 'no language'} instead of ${tag.trim()}`)
  }

  async setTimeZone(_id: string): Promise<void> {
    throw new Error('The iOS simulator follows the time zone of the Mac')
  }

  /** Writes the original strings back, or deletes the key when it did not exist. */
  async restoreLanguage(baseline: LocaleBaselineEntry): Promise<void> {
    const languages = baseline.languages
    if (!languages || languages.length === 0) await this.run(this.deleteCommand('AppleLanguages'))
    else await this.run(this.writeLanguagesCommand(languages))
    const locale = baseline.appleLocale
    if (locale === undefined) await this.run(this.deleteCommand('AppleLocale'))
    else await this.run(this.writeLocaleCommand(locale))
  }
}

/** What the first language / time zone change per device replaced, so Reset can put it back. */
export class LocaleBaseline {
  private readonly entries = new Map<string, LocaleBaselineEntry>()

  private static blank: LocaleBaselineEntry = { languageChanged: false, timeZoneChanged: false }

  rememberLanguage(deviceKey: string, current: LocaleState): void {
    const e = this.entries.get(deviceKey) ?? LocaleBaseline.blank
    if (!e.languageChanged) this.entries.set(deviceKey, { ...e, languages: current.languages, appleLocale: current.appleLocale, languageChanged: true })
  }

  rememberTimeZone(deviceKey: string, current: LocaleState): void {
    const e = this.entries.get(deviceKey) ?? LocaleBaseline.blank
    if (!e.timeZoneChanged) this.entries.set(deviceKey, { ...e, timeZone: current.timeZone, timeZoneChanged: true })
  }

  entry(deviceKey: string): LocaleBaselineEntry | undefined {
    return this.entries.get(deviceKey)
  }

  clearLanguage(deviceKey: string): void {
    const e = this.entries.get(deviceKey)
    if (e) this.entries.set(deviceKey, { ...e, languageChanged: false, languages: undefined, appleLocale: undefined })
  }

  clearTimeZone(deviceKey: string): void {
    const e = this.entries.get(deviceKey)
    if (e) this.entries.set(deviceKey, { ...e, timeZoneChanged: false, timeZone: undefined })
  }
}

/** Outcome of [LocaleActions.reset]: [failure] is the first error, [note] a caveat to show (Android language list), [restored] whether anything was changed. */
export interface LocaleResetOutcome {
  readonly failure: string | undefined
  readonly note: string | undefined
  readonly restored: boolean
}

/** Orchestration of the language and time zone controls: baseline, write, reset. */
export class LocaleActions {
  constructor(readonly baseline: LocaleBaseline = new LocaleBaseline()) {}

  /** Text for the confirm dialog before an Android system language change, undefined when nothing would be lost. */
  androidListLossWarning(current: LocaleState, newTag: string): string | undefined {
    const langs = current.languages
    if (!langs || langs.length < 2) return undefined
    return (
      `Android keeps only ONE system language this way. Your list (${langs.join(', ')}) will be replaced by ${newTag}, ` +
      `and Reset to defaults can only bring back ${langs[0]}. Re-add the others in Settings > System > Languages.`
    )
  }

  async changeLanguage(deviceKey: string, backend: LocaleBackend, before: LocaleState, tag: string): Promise<string | undefined> {
    const had = this.baseline.entry(deviceKey)?.languageChanged === true
    this.baseline.rememberLanguage(deviceKey, before)
    const failure = await fail(() => backend.setLanguage(tag, before))
    // A failed write that left the device as it was must not leave a baseline behind (Reset would "restore" and collapse the list).
    if (failure !== undefined && !had) {
      const now = await backend.read().catch(() => undefined)
      if (now && sameList(now.languages, before.languages) && now.appleLocale === before.appleLocale) this.baseline.clearLanguage(deviceKey)
    }
    return failure
  }

  async changeTimeZone(deviceKey: string, backend: LocaleBackend, before: LocaleState, id: string): Promise<string | undefined> {
    if (!backend.canSetTimeZone) return `The ${backend.platform} device cannot change its time zone`
    const had = this.baseline.entry(deviceKey)?.timeZoneChanged === true
    this.baseline.rememberTimeZone(deviceKey, before)
    const failure = await fail(() => backend.setTimeZone(id))
    if (failure !== undefined && !had) {
      const now = await backend.read().catch(() => undefined)
      if (now && now.timeZone === before.timeZone) this.baseline.clearTimeZone(deviceKey)
    }
    return failure
  }

  /** Restores what the tab changed. A failure leaves that part's baseline in place so a second Reset tries again. */
  async reset(deviceKey: string, backend: LocaleBackend): Promise<LocaleResetOutcome> {
    const e = this.baseline.entry(deviceKey)
    if (!e) return { failure: undefined, note: undefined, restored: false }
    let note: string | undefined
    if (e.languageChanged) {
      const failure = await fail(() => backend.restoreLanguage(e))
      if (failure !== undefined) return { failure, note: undefined, restored: true }
      this.baseline.clearLanguage(deviceKey)
      const langs = e.languages
      if (backend.platform === 'ANDROID' && langs && langs.length > 1) {
        note = `Language restored to ${langs[0]} only; re-add ${langs.slice(1).join(', ')} in Settings > System > Languages.`
      }
    }
    if (e.timeZoneChanged && e.timeZone !== undefined) {
      const zone = e.timeZone
      const failure = await fail(() => backend.setTimeZone(zone))
      if (failure !== undefined) return { failure, note, restored: true }
      this.baseline.clearTimeZone(deviceKey)
    }
    return { failure: undefined, note, restored: e.languageChanged || e.timeZoneChanged }
  }
}

async function fail(block: () => Promise<void>): Promise<string | undefined> {
  try {
    await block()
    return undefined
  } catch (e) {
    return messageOf(e)
  }
}
