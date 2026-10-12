// ported-from: test:core/LocaleTest.kt
import { describe, expect, it } from 'vitest'
import { AndroidLocale, IosLocale, LocaleActions, LocaleParsers, LocalePresets, LocaleState, LocaleValidation } from '../../src/core/display/locale'
import { CommandResult } from '../../src/core/exec/commandRunner'
import { fixture } from '../helpers/fixtures'
import { ok, RecordingRunner } from '../helpers/fakeRunner'

const result = (exit: number, stderr: string) => new CommandResult(exit, Buffer.alloc(0), stderr)
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const rejectMessage = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  return undefined
}

describe('LocaleTest', () => {
  it('validatesLanguageTags', () => {
    for (const t of [...LocalePresets.LANGUAGES, 'en', 'zh-Hans-CN', 'sr-Latn-RS', 'es-419', 'ar-SA-u-nu-latn']) expect(LocaleValidation.languageError(t), t).toBeUndefined()
    for (const t of ['', '  ', 'en-US,nl-NL', 'bad tag!!', 'e', 'english', 'en_US', 'en-']) expect(LocaleValidation.languageError(t), t).toBeDefined()
  })

  it('validatesTimeZoneIds', () => {
    for (const t of LocalePresets.TIME_ZONES) expect(LocaleValidation.timeZoneError(t), t).toBeUndefined()
    for (const t of ['', 'Not/AZone', 'Tokyo', 'europe/amsterdam x']) expect(LocaleValidation.timeZoneError(t), t).toBeDefined()
  })

  it('parsesRealOutput', () => {
    expect(LocaleParsers.androidLanguages('en-US,nl-NL\n')).toEqual(['en-US', 'nl-NL'])
    expect(LocaleParsers.androidLanguages('null\n')).toEqual([])
    expect(LocaleParsers.deviceLocale(fixture('android_get_device_locale.txt'))).toBe('en-US')
    expect(LocaleParsers.deviceLocale(fixture('android_set_device_locale_invalid.txt'))).toBeUndefined()
    expect(LocaleParsers.appLocales(fixture('android_get_app_locales.txt'))).toEqual(['nl-NL'])
    expect(LocaleParsers.appLocales(fixture('android_get_app_locales_empty.txt'))).toEqual([])
    expect(LocaleParsers.appLocales(fixture('android_set_app_locales_unknown_package.txt'))).toBeUndefined()
    expect(LocaleParsers.iosLanguages(fixture('ios_defaults_read_AppleLanguages.txt'))).toEqual(['en-NL', 'nl-NL'])
    expect(LocaleParsers.iosLocale(fixture('ios_defaults_read_AppleLocale.txt'))).toBe('en_NL')
    expect(LocaleParsers.commandError(fixture('android_set_device_locale_invalid.txt'))).toBe('Error: Invalid locale tag: en-US,nl-NL')
    expect(LocaleParsers.commandError('')).toBeUndefined()
  })

  it('normalisesAndBuildsIosValues', () => {
    expect(LocaleParsers.toHyphen('en_US')).toBe('en-US')
    expect(LocaleParsers.toIosLocale('fr-FR')).toBe('fr_FR')
    expect(LocaleParsers.toIosLocale('zh-Hans-CN')).toBe('zh_CN')
    expect(LocaleParsers.toIosLocale('nl')).toBe('nl')
    expect(LocaleParsers.iosLanguageList('fr-FR', ['en-NL', 'nl-NL'])).toEqual(['fr-FR', 'en-NL', 'nl-NL'])
    expect(LocaleParsers.iosLanguageList('nl-NL', ['en-NL', 'nl-NL'])).toEqual(['nl-NL', 'en-NL'])
    expect(LocaleParsers.plistArray(['fr-FR', 'en-NL'])).toBe('("fr-FR","en-NL")')
  })

  /** A tiny fake Android: state in variables, commands update them like the real tools. */
  function android(): [AndroidLocale, RecordingRunner] {
    let langs = 'en-US,nl-NL'
    let tz = 'Europe/Amsterdam'
    const r = new RecordingRunner((c) => {
      const s = c.slice(4)
      const is = (...x: string[]) => s.length === x.length && x.every((v, i) => v === s[i])
      if (is('settings', 'get', 'system', 'system_locales')) return ok(langs + '\n')
      if (is('cmd', 'locale', 'get-device-locale')) return ok(langs.split(',')[0] + '\n')
      if (same(s.slice(0, 3), ['cmd', 'locale', 'set-device-locale'])) {
        if (s[3].includes(',')) return ok(`Error: Invalid locale tag: ${s[3]}\n`)
        langs = s[3]
        return ok('')
      }
      if (is('getprop', 'persist.sys.timezone')) return ok(tz + '\n')
      if (same(s.slice(0, 3), ['cmd', 'alarm', 'set-timezone'])) {
        if (s[3] !== 'Not/AZone') tz = s[3]
        return ok('')
      }
      return result(1, `unexpected ${c}`)
    })
    return [new AndroidLocale('adb', 'emulator-5554', r), r]
  }

  /** Android fake whose tools exit 0 but ignore (or reject by text / exit code) chosen valid inputs. */
  function badAndroid(mode: string): AndroidLocale {
    const r = new RecordingRunner((c) => {
      const s = c.slice(4)
      const is = (...x: string[]) => s.length === x.length && x.every((v, i) => v === s[i])
      if (is('settings', 'get', 'system', 'system_locales')) return ok('en-US,nl-NL\n')
      if (is('cmd', 'locale', 'get-device-locale')) return ok('en-US\n')
      if (same(s.slice(0, 3), ['cmd', 'locale', 'set-device-locale'])) {
        if (mode === 'text') return ok('Error: Invalid locale tag\n')
        if (mode === 'exit') return result(3, 'boom')
        return ok('') // silently ignored
      }
      if (is('getprop', 'persist.sys.timezone')) return ok('Europe/Amsterdam\n')
      if (same(s.slice(0, 3), ['cmd', 'alarm', 'set-timezone'])) return ok('') // ignored
      return result(1, `unexpected ${c}`)
    })
    return new AndroidLocale('adb', 'emulator-5554', r)
  }

  it('androidReadsLanguageListAndZone', async () => {
    const st = await android()[0].read()
    expect(st.languages).toEqual(['en-US', 'nl-NL'])
    expect(st.primary).toBe('en-US')
    expect(st.timeZone).toBe('Europe/Amsterdam')
  })

  it('androidChangeAndResetRestoresFirstLanguageAndZone', async () => {
    const [b, runner] = android()
    const actions = new LocaleActions()
    const before = await b.read()
    expect(actions.androidListLossWarning(before, 'fr-FR')).toContain('en-US, nl-NL')
    expect(await actions.changeLanguage('d', b, before, 'fr-FR')).toBeUndefined()
    expect(await actions.changeTimeZone('d', b, before, 'Asia/Tokyo')).toBeUndefined()
    expect((await b.read()).languages).toEqual(['fr-FR'])
    expect((await b.read()).timeZone).toBe('Asia/Tokyo')
    // a second change keeps the first baseline
    expect(await actions.changeLanguage('d', b, await b.read(), 'de-DE')).toBeUndefined()
    const outcome = await actions.reset('d', b)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.note).toContain('nl-NL')
    expect((await b.read()).languages).toEqual(['en-US'])
    expect((await b.read()).timeZone).toBe('Europe/Amsterdam')
    expect(runner.commands.some((c) => same(c.slice(-4), ['cmd', 'locale', 'set-device-locale', 'fr-FR']))).toBe(true)
    expect((await actions.reset('d', b)).restored).toBe(false)
  })

  it('androidRejectsInvalidInputBeforeAnyCommand', async () => {
    const [b] = android()
    const st = await b.read()
    expect(await rejectMessage(b.setTimeZone('Not/AZone'))).toBe('Unknown time zone id "Not/AZone"')
    expect(await new LocaleActions().changeLanguage('d', b, st, 'en-US,nl-NL')).toContain('one language tag')
  })

  it('androidReportsSilentFailuresByReadBack', async () => {
    const st = await badAndroid('silent').read()
    const tz = await rejectMessage(badAndroid('silent').setTimeZone('Australia/Sydney'))
    expect(tz).toBe('The device reports Europe/Amsterdam instead of Australia/Sydney')
    const lang = await rejectMessage(badAndroid('silent').setLanguage('fr-FR', st))
    expect(lang).toContain('device reports en-US instead of fr-FR')
  })

  it('androidReportsErrorTextAndExitCode', async () => {
    const st = await badAndroid('text').read()
    expect(await rejectMessage(badAndroid('text').setLanguage('fr-FR', st))).toContain('Invalid locale tag')
    expect(await rejectMessage(badAndroid('exit').setLanguage('fr-FR', st))).toContain('boom')
  })

  it('failedWriteLeavesNoBaselineWhenDeviceUnchanged', async () => {
    const b = badAndroid('silent')
    const before = await b.read()
    const actions = new LocaleActions()
    expect(await actions.changeLanguage('d', b, before, 'fr-FR')).toBeDefined()
    expect(await actions.changeTimeZone('d', b, before, 'Australia/Sydney')).toBeDefined()
    expect(actions.baseline.entry('d')?.languageChanged ?? false).toBe(false)
    expect(actions.baseline.entry('d')?.timeZoneChanged ?? false).toBe(false)
    expect((await actions.reset('d', b)).restored).toBe(false)
  })

  it('failedWriteKeepsEarlierBaseline', async () => {
    const [b] = android()
    const actions = new LocaleActions()
    expect(await actions.changeLanguage('d', b, await b.read(), 'fr-FR')).toBeUndefined()
    // second change fails (comma rejected) but the device did change earlier: baseline must stay
    expect(await actions.changeLanguage('d', b, await b.read(), 'a,b')).toBeDefined()
    expect(actions.baseline.entry('d')!.languageChanged).toBe(true)
  })

  it('resetKeepsBaselineAfterFailureAndRetries', async () => {
    let failing = true
    let langs = 'en-US,nl-NL'
    const r = new RecordingRunner((c) => {
      const s = c.slice(4)
      if (same(s, ['settings', 'get', 'system', 'system_locales'])) return ok(langs + '\n')
      if (same(s, ['cmd', 'locale', 'get-device-locale'])) return ok(langs.split(',')[0] + '\n')
      if (same(s.slice(0, 3), ['cmd', 'locale', 'set-device-locale'])) {
        if (failing && s[3] === 'en-US') return result(1, 'adb offline')
        langs = s[3]
        return ok('')
      }
      return result(1, `unexpected ${c}`)
    })
    const b = new AndroidLocale('adb', 'e', r)
    const actions = new LocaleActions()
    expect(await actions.changeLanguage('d', b, await b.read(), 'fr-FR')).toBeUndefined()
    expect((await actions.reset('d', b)).failure).toBe('adb offline')
    expect(actions.baseline.entry('d')!.languageChanged).toBe(true)
    failing = false
    const second = await actions.reset('d', b)
    expect(second.failure).toBeUndefined()
    expect((await b.read()).languages).toEqual(['en-US'])
  })

  it('iosSetLanguageDetectsReadBackMismatch', async () => {
    const r = new RecordingRunner((c) => {
      const s = c.slice(5)
      if (same(s, ['read', '-g', 'AppleLanguages'])) return ok('(\n    "en-NL"\n)\n')
      if (same(s, ['read', '-g', 'AppleLocale'])) return ok('en_NL\n')
      if (same(s.slice(0, 2), ['write', '-g'])) return ok('')
      return result(1, `unexpected ${c}`)
    })
    const b = new IosLocale('xcrun', 'UDID', r, () => 'UTC')
    expect(await rejectMessage(b.setLanguage('fr-FR', await b.read()))).toBe('The simulator reports en-NL instead of fr-FR')
  })

  it('androidSingleLanguageNeedsNoWarning', () => {
    expect(new LocaleActions().androidListLossWarning(new LocaleState(['en-US'], undefined, 'UTC'), 'nl-NL')).toBeUndefined()
  })

  function ios(initial: string[] | undefined, locale: string | undefined) {
    let langs = initial
    let loc = locale
    const r = new RecordingRunner((c) => {
      const s = c.slice(5) // xcrun simctl spawn udid defaults
      if (same(s, ['read', '-g', 'AppleLanguages']))
        return langs
          ? ok(langs.map((l) => `    "${l}"`).join(',\n').replace(/^/, '(\n') + '\n)\n')
          : result(1, 'The domain/default pair of (kCFPreferencesAnyApplication, AppleLanguages) does not exist')
      if (same(s, ['read', '-g', 'AppleLocale'])) return loc !== undefined ? ok(loc + '\n') : result(1, 'does not exist')
      if (same(s.slice(0, 3), ['write', '-g', 'AppleLanguages'])) {
        langs = LocaleParsers.iosLanguages(s[3].replace(/^[()]+|[()]+$/g, '').replace(/,/g, '\n'))
        return ok('')
      }
      if (same(s.slice(0, 3), ['write', '-g', 'AppleLocale'])) {
        loc = s[3]
        return ok('')
      }
      if (same(s, ['delete', '-g', 'AppleLanguages'])) {
        langs = undefined
        return ok('')
      }
      if (same(s, ['delete', '-g', 'AppleLocale'])) {
        loc = undefined
        return ok('')
      }
      return result(1, `unexpected ${c}`)
    })
    return { backend: new IosLocale('xcrun', 'UDID', r, () => 'Europe/Amsterdam'), runner: r, now: () => [langs, loc] as [string[] | undefined, string | undefined] }
  }

  it('iosReadsHostZoneAndLanguages', async () => {
    const st = await ios(['en-NL', 'nl-NL'], 'en_NL').backend.read()
    expect(st.languages).toEqual(['en-NL', 'nl-NL'])
    expect(st.appleLocale).toBe('en_NL')
    expect(st.timeZone).toBe('Europe/Amsterdam')
    expect(st.timeZoneFollowsHost).toBe(true)
  })

  it('iosChangeKeepsOtherLanguagesAndResetRestoresExactly', async () => {
    const { backend: b, runner, now } = ios(['en-NL', 'nl-NL'], 'en_NL')
    const actions = new LocaleActions()
    const before = await b.read()
    expect(await actions.changeLanguage('d', b, before, 'fr-FR')).toBeUndefined()
    expect(now()).toEqual([['fr-FR', 'en-NL', 'nl-NL'], 'fr_FR'])
    expect(runner.commands.some((c) => c.at(-1) === '("fr-FR","en-NL","nl-NL")')).toBe(true)
    expect(await actions.changeTimeZone('d', b, before, 'UTC')).toContain('cannot change')
    const outcome = await actions.reset('d', b)
    expect(outcome.failure).toBeUndefined()
    expect(outcome.note).toBeUndefined()
    expect(now()).toEqual([['en-NL', 'nl-NL'], 'en_NL'])
  })

  it('iosResetDeletesKeysThatDidNotExist', async () => {
    const { backend: b, now } = ios(undefined, undefined)
    const actions = new LocaleActions()
    expect((await b.read()).languages).toEqual([])
    expect(await actions.changeLanguage('d', b, await b.read(), 'de-DE')).toBeUndefined()
    expect(now()).toEqual([['de-DE'], 'de_DE'])
    expect((await actions.reset('d', b)).failure).toBeUndefined()
    expect(now()).toEqual([undefined, undefined])
  })
})
