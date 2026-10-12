// ported-from: test:core/InputTest.kt
import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../../src/core/exec/commandRunner'
import { HardwareButtons, InputActions, InputKeys, InputParsers, type HardwareButton } from '../../src/core/input/input'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { MobilecliException } from '../../src/core/mobilecliJson'
import type { Platform } from '../../src/core/model'
import { fixture } from '../helpers/fixtures'
import { fail, ok, RecordingRunner } from '../helpers/fakeRunner'

const android = (runner: CommandRunner, mobilecli: boolean) =>
  new InputActions('ANDROID', 'emulator-5554', runner, 'adb', undefined, mobilecli ? new MobilecliClient('mobilecli', runner) : undefined, mobilecli ? 'Pixel_9' : undefined)

const ios = (runner: CommandRunner, mobilecli = true) =>
  new InputActions('IOS', 'UDID', runner, undefined, 'xcrun', mobilecli ? new MobilecliClient('mobilecli', runner) : undefined, mobilecli ? 'UDID' : undefined)

const message = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a failure')
}

describe('InputTest', () => {
  it('buttonsPerPlatform', () => {
    expect(HardwareButtons.forPlatform('ANDROID')).toEqual(['VOLUME_UP', 'VOLUME_DOWN', 'HOME', 'POWER', 'BACK', 'APP_SWITCH', 'ASSISTANT'])
    expect(HardwareButtons.forPlatform('IOS')).toEqual(['VOLUME_UP', 'VOLUME_DOWN', 'HOME', 'POWER', 'SHAKE'])
    expect(HardwareButtons.mobilecliName('POWER', 'IOS')).toBe('LOCK')
    expect(HardwareButtons.mobilecliName('POWER', 'ANDROID')).toBe('POWER')
    expect(HardwareButtons.mobilecliName('ASSISTANT', 'ANDROID')).toBeUndefined()
    expect(
      HardwareButtons.values.every((b: HardwareButton) =>
        [HardwareButtons.androidName(b), HardwareButtons.iosName(b)].filter((n): n is string => n !== undefined).every((n) => n === n.toUpperCase()),
      ),
    ).toBe(true)
  })

  it('keyNamesAreMobilecliSpelling', () => {
    expect(InputKeys.values.map(InputKeys.mobilecli)).toEqual(['tab', 'escape', 'enter', 'backspace', 'delete', 'up', 'down', 'left', 'right'])
  })

  it('parsesReadBacks', () => {
    expect(InputParsers.wakefulness('  mWakefulness=Awake\n mWakefulnessChanging=false')).toBe('Awake')
    expect(InputParsers.volume('[V] volume is 5 in range [0..15]')?.toString()).toBe('5/15')
    expect(InputParsers.volume('   streamVolume:5')?.toString()).toBe('5')
    expect(InputParsers.volume('nothing')).toBeUndefined()
    expect(InputParsers.imeVisible('  mImeWindowVis=3\n')).toBe(true)
    expect(InputParsers.imeVisible('  mImeWindowVis=0\n')).toBe(false)
    expect(InputParsers.imeVisible('mImeWindowVis=0x1')).toBe(true)
    expect(InputParsers.imeVisible('nothing')).toBeUndefined()
    expect(InputParsers.locked('com.apple.springboard.lockstate 1\n')).toBe(true)
    expect(InputParsers.locked('com.apple.springboard.lockstate 0')).toBe(false)
  })

  it('mobilecliButtonAndClipboardFixtures', async () => {
    const sent = new RecordingRunner(() => ok(fixture('mobilecli-button-ok.json')))
    await new MobilecliClient('mobilecli', sent).button('Pixel_9', 'VOLUME_UP')
    expect(sent.commands).toEqual([['mobilecli', 'io', 'button', '--device', 'Pixel_9', 'VOLUME_UP']])

    const get = new RecordingRunner(() => ok(fixture('mobilecli-clipboard-get-ok.json')))
    expect(await new MobilecliClient('m', get).clipboardGet('x')).toBe('line1\nline "two" é ✓ $HOME')
    expect(await new MobilecliClient('m', new RecordingRunner(() => ok(fixture('mobilecli-clipboard-get-empty.json')))).clipboardGet('x')).toBe('')

    const set = new RecordingRunner(() => ok(fixture('mobilecli-clipboard-set-ok.json')))
    await new MobilecliClient('m', set).clipboardSet('x', '-dash')
    expect(set.commands).toEqual([['m', 'io', 'clipboard', 'set', '--device', 'x', '--', '-dash']])
  })

  it('unsupportedButtonSurfacesMobilecliText', async () => {
    const runner = new RecordingRunner(() => fail(fixture('mobilecli-button-error-android.json')))
    const e = await new MobilecliClient('m', runner).button('Pixel_9', 'ASSISTANT').catch((x) => x)
    expect(e).toBeInstanceOf(MobilecliException)
    expect((e as Error).message).toContain('unsupported button key: ASSISTANT')
  })

  it('androidButtonsGoThroughMobilecliOrAdb', async () => {
    const withCli = new RecordingRunner(() => ok(fixture('mobilecli-button-ok.json')))
    expect(await android(withCli, true).press('POWER')).toBe('Pressed POWER')
    expect(withCli.commands).toEqual([['mobilecli', 'io', 'button', '--device', 'Pixel_9', 'POWER']])

    const adbOnly = new RecordingRunner(() => ok())
    await android(adbOnly, false).press('APP_SWITCH')
    expect(adbOnly.commands).toEqual([['adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', '187']])

    const assistant = new RecordingRunner(() => ok())
    await android(assistant, true).press('ASSISTANT')
    expect(assistant.commands).toEqual([['adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', '219']])
  })

  it('iosLockShakeAndMissingMobilecli', async () => {
    const r = new RecordingRunner(() => ok(fixture('mobilecli-button-ok.json')))
    await ios(r).press('POWER')
    expect(r.commands[0].at(-1)).toBe('LOCK')
    const shake = new RecordingRunner(() => ok())
    await ios(shake, false).press('SHAKE')
    expect(shake.commands).toEqual([['xcrun', 'simctl', 'spawn', 'UDID', 'notifyutil', '-p', 'com.apple.UIKit.SimulatorShake']])
    expect(await message(ios(new RecordingRunner(() => ok()), false).press('HOME'))).toContain('mobilecli')
    expect(await message(ios(new RecordingRunner(() => ok())).press('BACK'))).toContain('not available')
  })

  it('keysFallBackToAdbOnAndroidOnly', async () => {
    const adbOnly = new RecordingRunner(() => ok())
    await android(adbOnly, false).pressKey('TAB')
    expect(adbOnly.commands[0].at(-1)).toBe('61')
    const cli = new RecordingRunner(() => ok(fixture('mobilecli-button-ok.json')))
    await android(cli, true).pressKey('LEFT')
    expect(cli.commands).toEqual([['mobilecli', 'io', 'keys', '--device', 'Pixel_9', 'left']])
    expect(await message(ios(new RecordingRunner(() => ok()), false).pressKey('TAB'))).toContain('mobilecli')
  })

  it('hideKeyboardSendsEscapeOnlyWhenShown', async () => {
    const shown = new RecordingRunner((cmd) => (cmd.includes('dumpsys') ? ok('mImeWindowVis=3') : ok()))
    await android(shown, false).hideKeyboard()
    expect(shown.commands.at(-1)!.at(-1)).toBe('111')
    const hidden = new RecordingRunner(() => ok('mImeWindowVis=0'))
    expect(await android(hidden, false).hideKeyboard()).toBe('The keyboard is not shown')
    expect(hidden.commands).toHaveLength(1)
    await message(ios(new RecordingRunner(() => ok())).hideKeyboard())
  })

  it('clipboardNeedsMobilecliAndPasteComboPerPlatform', async () => {
    expect((await message(android(new RecordingRunner(() => ok()), false).clipboardGet())).startsWith('Clipboard needs mobilecli')).toBe(true)
    const a = new RecordingRunner(() => ok(fixture('mobilecli-clipboard-set-ok.json')))
    await android(a, true).setAndPaste('hi')
    expect(a.commands.map((c) => c[2])).toEqual(['clipboard', 'keys'])
    expect(a.commands.at(-1)!.at(-1)).toBe('ctrl+v')
    const i = new RecordingRunner(() => ok(fixture('mobilecli-clipboard-set-ok.json')))
    expect(await ios(i).setAndPaste('hi')).toContain('Allow Paste')
    expect(i.commands.at(-1)!.at(-1)).toBe('cmd+v')
  })

  it('statusReadBack', async () => {
    const r = new RecordingRunner((cmd) => (cmd.includes('power') ? ok('mWakefulness=Asleep') : ok('[V] volume is 6 in range [0..15]')))
    expect(await android(r, false).status()).toBe('screen Asleep, media volume 6/15')
    expect(await ios(new RecordingRunner(() => ok('com.apple.springboard.lockstate 1'))).status()).toBe('locked')
    expect(HardwareButtons.supports('SHAKE', 'ANDROID' as Platform)).toBe(false)
  })
})
