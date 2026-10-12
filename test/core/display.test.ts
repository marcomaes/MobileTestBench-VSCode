// ported-from: test:core/DisplayTest.kt
import { describe, expect, it } from 'vitest'
import {
  AndroidDisplay,
  Appearances,
  DisplayActions,
  DisplayBaseline,
  DisplayDefaults,
  DisplayKeys,
  DisplayParsers,
  DisplayState,
  FontPresets,
  IosDisplay,
  type DisplayBackend,
  type DisplayKey,
} from '../../src/core/display/display'
import type { Platform } from '../../src/core/model'
import { CommandResult } from '../../src/core/exec/commandRunner'
import { fixture } from '../helpers/fixtures'
import { ok, RecordingRunner } from '../helpers/fakeRunner'

const state = (...v: Array<[DisplayKey, string | undefined]>) => new DisplayState(new Map(v))
const failed = (exit: number, stderr: string, stdout = '') => new CommandResult(exit, Buffer.from(stdout), stderr)
const rejects = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a failure')
}

describe('DisplayTest', () => {
  it('parsesNightMode', () => {
    expect(DisplayParsers.nightMode(fixture('android-uimode-night-no.txt'))).toBe('no')
    expect(DisplayParsers.nightMode(fixture('android-uimode-night-auto.txt'))).toBe('auto')
    expect(DisplayParsers.nightMode('Night mode: custom_schedule\n')).toBe('custom_schedule')
    expect(DisplayParsers.nightMode(fixture('android-uimode-night-error.txt'))).toBeUndefined()
  })

  it('unsetSettingsReadAsNull', () => {
    expect(DisplayParsers.settingValue('null\n')).toBeUndefined()
    expect(DisplayParsers.settingValue('\n')).toBeUndefined()
    expect(DisplayParsers.settingValue('')).toBeUndefined()
    expect(DisplayParsers.settingValue('1.3\n')).toBe('1.3')
  })

  it('simctlValuesAreLowercasedAndErrorsDetected', () => {
    expect(DisplayParsers.simctlValue(fixture('simctl-content-size-extra-small.txt'))).toBe('extra-small')
    expect(DisplayParsers.simctlValue('Small\n')).toBe('small')
    expect(DisplayParsers.simctlValue('unsupported')).toBeUndefined()
    expect(DisplayParsers.simctlValue('Invalid argument')).toBeUndefined()
    expect(DisplayParsers.simctlError('Invalid argument\n')).toBe('Invalid argument')
    expect(DisplayParsers.simctlError('Unknown apperance: bogus')).toBe('Unknown apperance: bogus')
    expect(DisplayParsers.simctlError('large\n')).toBeUndefined()
  })

  it('fontPresetMapping', () => {
    expect(FontPresets.fromAndroid('1.0')).toBe('DEFAULT')
    expect(FontPresets.fromAndroid(undefined)).toBe('DEFAULT')
    expect(FontPresets.fromAndroid('0.85')).toBe('SMALL')
    expect(FontPresets.fromAndroid('1.15')).toBe('LARGE')
    expect(FontPresets.fromAndroid('1.3')).toBe('LARGEST')
    expect(FontPresets.fromAndroid('1.5')).toBeUndefined()
    expect(FontPresets.fromAndroid('abc')).toBeUndefined()
    expect(FontPresets.fromIos('large')).toBe('DEFAULT')
    expect(FontPresets.fromIos('accessibility-extra-extra-extra-large')).toBe('LARGEST')
    expect(FontPresets.fromIos('medium')).toBeUndefined()
    expect(FontPresets.raw('LARGE', 'ANDROID')).toBe('1.15')
    expect(FontPresets.raw('LARGE', 'IOS')).toBe('extra-extra-large')
  })

  it('appearanceMapping', () => {
    expect(Appearances.forPlatform('ANDROID')).toEqual(['AUTO', 'LIGHT', 'DARK'])
    expect(Appearances.forPlatform('IOS')).toEqual(['LIGHT', 'DARK'])
    expect(Appearances.raw('DARK', 'ANDROID')).toBe('yes')
    expect(Appearances.raw('LIGHT', 'ANDROID')).toBe('no')
    expect(Appearances.raw('DARK', 'IOS')).toBe('dark')
    expect(() => Appearances.raw('AUTO', 'IOS')).toThrow()
    expect(Appearances.fromRaw('ANDROID', 'no')).toBe('LIGHT')
    expect(Appearances.fromRaw('ANDROID', 'auto')).toBe('AUTO')
    expect(Appearances.fromRaw('ANDROID', 'custom_schedule')).toBeUndefined()
    expect(Appearances.fromRaw('IOS', 'dark')).toBe('DARK')
  })

  it('androidWriteCommands', () => {
    const d = new AndroidDisplay('adb', 'emulator-5554', new RecordingRunner())
    const pre = ['adb', '-s', 'emulator-5554', 'shell']
    expect(d.writeCommand('APPEARANCE', 'yes')).toEqual([...pre, 'cmd', 'uimode', 'night', 'yes'])
    expect(d.writeCommand('APPEARANCE', undefined)).toEqual([...pre, 'cmd', 'uimode', 'night', 'auto'])
    expect(d.writeCommand('FONT_SIZE', '1.3')).toEqual([...pre, 'settings', 'put', 'system', 'font_scale', '1.3'])
    expect(d.writeCommand('WINDOW_SCALE', '0')).toEqual([...pre, 'settings', 'put', 'global', 'window_animation_scale', '0'])
    expect(d.writeCommand('ANIMATOR_SCALE', undefined)).toEqual([...pre, 'settings', 'delete', 'global', 'animator_duration_scale'])
    expect(d.writeCommand('SHOW_TOUCHES', '1')).toEqual([...pre, 'settings', 'put', 'system', 'show_touches', '1'])
    expect(d.writeCommand('SHOW_TOUCHES', undefined)).toEqual([...pre, 'settings', 'delete', 'system', 'show_touches'])
    expect(d.writeCommand('LAYOUT_BOUNDS', 'true')).toEqual([...pre, 'setprop debug.layout true'])
    // The empty value must be inside one shell string, adb drops an empty argument.
    expect(d.writeCommand('LAYOUT_BOUNDS', undefined)).toEqual([...pre, "setprop debug.layout ''"])
  })

  it('androidRejectsValuesThatCouldReachTheShell', () => {
    const d = new AndroidDisplay('adb', 's', new RecordingRunner())
    for (const bad of ['1; reboot', 'a b', '', '$(id)', "x'y"]) expect(() => d.writeCommand('FONT_SIZE', bad), `accepted: ${bad}`).toThrow()
  })

  it('androidReadCollectsRawValuesAndErrors', async () => {
    const runner = new RecordingRunner((cmd) => {
      const line = cmd.slice(4).join(' ')
      if (line === 'cmd uimode night') return ok('Night mode: no\n')
      if (line.endsWith('font_scale')) return ok('1.0\n')
      if (line.endsWith('animator_duration_scale')) return ok('null\n')
      if (line.endsWith('window_animation_scale') || line.endsWith('transition_animation_scale')) return ok('1.0\n')
      if (line.endsWith('show_touches')) return failed(255, 'boom\nsecond line')
      if (line === 'getprop debug.layout') return ok('\n')
      if (line.endsWith('pointer_location')) return ok('1\n')
      if (line.endsWith('always_finish_activities')) return ok('null\n')
      throw new Error(line)
    })
    const st = await new AndroidDisplay('adb', 's', runner).read()
    expect(st.values.get('APPEARANCE')).toBe('no')
    expect(st.values.get('FONT_SIZE')).toBe('1.0')
    expect(st.has('ANIMATOR_SCALE')).toBe(true)
    expect(st.values.get('ANIMATOR_SCALE')).toBeUndefined()
    expect(st.values.get('LAYOUT_BOUNDS')).toBeUndefined()
    expect(st.has('SHOW_TOUCHES')).toBe(false)
    expect(st.errors.get('SHOW_TOUCHES')).toBe('boom')
    expect(st.animationsOff).toBe(false)
    expect(st.showTouches).toBeUndefined()
    expect(st.layoutBounds).toBe(false)
    expect(st.pointerLocation).toBe(true)
    expect(st.dontKeepActivities).toBe(false)
    expect(st.errors.size).toBe(1)
  })

  it('androidPointerLocationAndDontKeepActivitiesCommands', () => {
    const d = new AndroidDisplay('adb', 's', new RecordingRunner())
    const pre = ['adb', '-s', 's', 'shell']
    expect(d.readCommand('POINTER_LOCATION')).toEqual([...pre, 'settings', 'get', 'system', 'pointer_location'])
    expect(d.readCommand('DONT_KEEP_ACTIVITIES')).toEqual([...pre, 'settings', 'get', 'global', 'always_finish_activities'])
    expect(d.writeCommand('POINTER_LOCATION', '1')).toEqual([...pre, 'settings', 'put', 'system', 'pointer_location', '1'])
    expect(d.writeCommand('DONT_KEEP_ACTIVITIES', '0')).toEqual([...pre, 'settings', 'put', 'global', 'always_finish_activities', '0'])
    expect(d.writeCommand('DONT_KEEP_ACTIVITIES', undefined)).toEqual([...pre, 'settings', 'delete', 'global', 'always_finish_activities'])
    expect(new DisplayState(new Map()).pointerLocation).toBeUndefined()
    expect(state(['POINTER_LOCATION', undefined]).pointerLocation).toBe(false)
    expect(state(['DONT_KEEP_ACTIVITIES', '1']).dontKeepActivities).toBe(true)
    const android = DisplayDefaults.forPlatform('ANDROID')
    expect(android.has('POINTER_LOCATION') && android.has('DONT_KEEP_ACTIVITIES')).toBe(true)
    expect(DisplayDefaults.forPlatform('IOS').has('POINTER_LOCATION')).toBe(false)
  })

  it('androidWriteFailureCarriesTheDeviceText', async () => {
    const runner = new RecordingRunner(() => failed(255, "Error: mode must be 'yes', 'no', or 'auto'\n"))
    const e = await rejects(new AndroidDisplay('adb', 's', runner).write('APPEARANCE', 'yes'))
    expect(e.message.startsWith('Error: mode must be')).toBe(true)
  })

  it('derivedStateValues', () => {
    const off = state(['WINDOW_SCALE', '0'], ['TRANSITION_SCALE', '0'], ['ANIMATOR_SCALE', '0.0'])
    expect(off.animationsOff).toBe(true)
    expect(state(['WINDOW_SCALE', '0'], ['TRANSITION_SCALE', '0'], ['ANIMATOR_SCALE', undefined]).animationsOff).toBe(false)
    expect(state(['WINDOW_SCALE', '0']).animationsOff).toBeUndefined()
    expect(state(['SHOW_TOUCHES', '1']).showTouches).toBe(true)
    expect(state(['SHOW_TOUCHES', '0']).showTouches).toBe(false)
    expect(state(['LAYOUT_BOUNDS', 'true']).layoutBounds).toBe(true)
  })

  it('iosCommandsAndErrorDetection', async () => {
    const runner = new RecordingRunner((cmd) => (cmd[cmd.length - 1] === 'bogus' ? ok('Invalid argument\n') : ok('')))
    const d = new IosDisplay('xcrun', 'UDID', runner)
    expect(d.readCommand('FONT_SIZE')).toEqual(['xcrun', 'simctl', 'ui', 'UDID', 'content_size'])
    expect(d.writeCommand('APPEARANCE', 'dark')).toEqual(['xcrun', 'simctl', 'ui', 'UDID', 'appearance', 'dark'])
    await d.write('APPEARANCE', 'dark')
    await d.write('FONT_SIZE', undefined)
    expect(runner.commands[runner.commands.length - 1]).toEqual(['xcrun', 'simctl', 'ui', 'UDID', 'content_size', 'large'])
    expect((await rejects(d.write('FONT_SIZE', 'bogus'))).message).toBe('Invalid argument')
    await rejects(d.write('SHOW_TOUCHES', '1'))
  })

  it('iosReadLowercasesAndReportsUnsupported', async () => {
    const runner = new RecordingRunner((cmd) => (cmd[cmd.length - 1] === 'appearance' ? ok('unsupported\n') : ok('extra-Small\n')))
    const st = await new IosDisplay('xcrun', 'U', runner).read()
    expect(st.values.get('FONT_SIZE')).toBe('extra-small')
    expect(st.has('APPEARANCE')).toBe(false)
    expect(st.errors.has('APPEARANCE')).toBe(true)
  })

  it('baselineKeepsTheFirstValueAndSkipsUnreadKeys', () => {
    const b = new DisplayBaseline()
    const first = state(['APPEARANCE', 'no'], ['ANIMATOR_SCALE', undefined])
    b.remember('dev', first, ['APPEARANCE', 'ANIMATOR_SCALE', 'SHOW_TOUCHES'])
    b.remember('dev', state(['APPEARANCE', 'yes']), ['APPEARANCE'])
    const o = b.originals('dev')
    expect(o.get('APPEARANCE')).toBe('no')
    expect(o.has('ANIMATOR_SCALE') && o.get('ANIMATOR_SCALE') === undefined).toBe(true)
    expect(o.has('SHOW_TOUCHES')).toBe(false)
    expect(b.originals('other').size).toBe(0)
    b.clear('dev')
    expect(b.originals('dev').size).toBe(0)
  })

  it('resetPlanUsesOriginalsOrDefaults', () => {
    expect(DisplayDefaults.resetPlan('ANDROID', new Map([['APPEARANCE', 'no']]))).toEqual([['APPEARANCE', 'no']])
    const android = new Map(DisplayDefaults.resetPlan('ANDROID', new Map()))
    expect(android.get('APPEARANCE')).toBe('auto')
    expect(android.get('FONT_SIZE')).toBe('1.0')
    expect(android.has('ANIMATOR_SCALE') && android.get('ANIMATOR_SCALE') === undefined).toBe(true)
    expect(android.size).toBe(DisplayKeys.values.length)
    const ios = new Map(DisplayDefaults.resetPlan('IOS', new Map()))
    expect(ios).toEqual(new Map([['APPEARANCE', 'light'], ['FONT_SIZE', 'large']]))
  })

  /** Records writes; fails for [failOn]. */
  class FakeBackend implements DisplayBackend {
    readonly keys = new Set(DisplayKeys.values)
    readonly writes: Array<[DisplayKey, string | undefined]> = []
    constructor(
      readonly platform: Platform = 'ANDROID',
      private readonly failOn?: DisplayKey,
    ) {}
    async read() {
      return new DisplayState(new Map())
    }
    async write(key: DisplayKey, value: string | undefined) {
      if (key === this.failOn) throw new Error(`refused ${key}`)
      this.writes.push([key, value])
    }
  }

  it('failedResetDoesNotRememberTheCurrentValues', async () => {
    const actions = new DisplayActions()
    const outcome = await actions.reset('dev', 'ANDROID', new FakeBackend('ANDROID', 'LAYOUT_BOUNDS'))
    expect(outcome.failure).toBe('refused LAYOUT_BOUNDS')
    expect(outcome.restored).toBe(false)
    expect(actions.baseline.originals('dev').size).toBe(0)
    // A second reset still applies the platform defaults, not stale pre-reset values.
    const good = new FakeBackend()
    const second = await actions.reset('dev', 'ANDROID', good)
    expect(second.failure).toBeUndefined()
    expect(good.writes).toEqual(DisplayDefaults.resetPlan('ANDROID', new Map()))
  })

  it('failedResetKeepsRememberedValuesAndSuccessClearsThem', async () => {
    const actions = new DisplayActions()
    const before = state(['APPEARANCE', 'no'], ['FONT_SIZE', '1.3'])
    expect(await actions.change('dev', new FakeBackend(), before, [['FONT_SIZE', '1.0']])).toBeUndefined()
    const bad = await actions.reset('dev', 'ANDROID', new FakeBackend('ANDROID', 'FONT_SIZE'))
    expect(bad.restored && bad.failure !== undefined).toBe(true)
    expect(actions.baseline.originals('dev')).toEqual(new Map([['FONT_SIZE', '1.3']]))
    const good = new FakeBackend()
    expect((await actions.reset('dev', 'ANDROID', good)).failure).toBeUndefined()
    expect(good.writes).toEqual([['FONT_SIZE', '1.3']])
    expect(actions.baseline.originals('dev').size).toBe(0)
  })

  it('changeRemembersBeforeWritingAndReportsFirstError', async () => {
    const actions = new DisplayActions()
    const before = state(['WINDOW_SCALE', undefined], ['TRANSITION_SCALE', '1.0'])
    const backend = new FakeBackend('ANDROID', 'TRANSITION_SCALE')
    const failure = await actions.change('dev', backend, before, [['WINDOW_SCALE', '0'], ['TRANSITION_SCALE', '0']])
    expect(failure).toBe('refused TRANSITION_SCALE')
    expect(backend.writes).toEqual([['WINDOW_SCALE', '0']])
    expect(actions.baseline.originals('dev').size).toBe(2)
  })

  it('androidWritesLayoutBoundsFalseAndUnset', async () => {
    const runner = new RecordingRunner(() => ok(''))
    const android = new AndroidDisplay('adb', 'emulator-5554', runner)
    await android.write('LAYOUT_BOUNDS', 'false')
    await android.write('LAYOUT_BOUNDS', undefined)
    expect(runner.commands).toHaveLength(2)
    expect(runner.commands[0].at(-1)).toBe('setprop debug.layout false')
    expect(runner.commands[1].at(-1)).toBe("setprop debug.layout ''")
  })

  it('iosReadReportsNonZeroExitAsError', async () => {
    const runner = new RecordingRunner(() => failed(1, 'No devices are booted.'))
    const st = await new IosDisplay('xcrun', 'UDID', runner).read()
    expect(st.values.size).toBe(0)
    expect(new Set(st.errors.keys())).toEqual(new Set(['APPEARANCE', 'FONT_SIZE']))
    expect(st.errors.get('APPEARANCE')).toContain('No devices are booted')
  })
})
