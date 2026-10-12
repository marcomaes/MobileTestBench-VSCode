// ported-from: test:core/DeviceKeysTransportTest.kt
import { describe, expect, it } from 'vitest'
import { AdbClient } from '../../src/core/android/adbClient'
import { AndroidSession } from '../../src/core/android/androidSession'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { MobilecliException } from '../../src/core/mobilecliJson'
import { makeDevice } from '../../src/core/model'
import { UnsupportedOperationOnDevice } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'
import { fail, ok, RecordingRunner } from '../helpers/fakeRunner'

const device = makeDevice({ id: 'emulator-5554', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR' })

/** The command lines behind Fill's select-all + backspace, and mobilecli's real answers (scouted fixtures). */
describe('DeviceKeysTransportTest', () => {
  it('mobilecli keys passes every combo as its own argument', async () => {
    const runner = new RecordingRunner(() => ok(fixture('mobilecli-keys-ok.json')))
    await new MobilecliClient('mobilecli', runner).keys('Pixel_9', ['cmd+a', 'backspace'])
    expect(runner.commands).toEqual([['mobilecli', 'io', 'keys', '--device', 'Pixel_9', 'cmd+a', 'backspace']])
  })

  it("a bad key surfaces mobilecli's own error text", async () => {
    for (const [file, text] of [
      ['mobilecli-keys-error-android.json', 'unsupported key'],
      ['mobilecli-keys-error-ios.json', 'Unsupported key'],
    ]) {
      const e = await new MobilecliClient('mobilecli', new RecordingRunner(() => fail(fixture(file)))).keys('x', ['foo']).catch((x) => x)
      expect(e, `expected an error for ${file}`).toBeInstanceOf(MobilecliException)
      expect((e as Error).message).toContain(text)
    }
  })

  it('adb key combination uses one keycombination call', async () => {
    const runner = new RecordingRunner()
    await new AdbClient('adb', runner).keyCombination('emulator-5554', 113, 29)
    expect(runner.commands).toEqual([['adb', '-s', 'emulator-5554', 'shell', 'input', 'keycombination', '113', '29']])
  })

  it('android without mobilecli maps ctrl+a and backspace to adb', async () => {
    const runner = new RecordingRunner()
    await new AndroidSession(device, new AdbClient('adb', runner), undefined).pressKeys(['ctrl+a', 'backspace'])
    expect(runner.commands).toEqual([
      ['adb', '-s', 'emulator-5554', 'shell', 'input', 'keycombination', '113', '29'],
      ['adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', '67'],
    ])
  })

  it('android without mobilecli rejects other keys', async () => {
    const runner = new RecordingRunner()
    const e = await new AndroidSession(device, new AdbClient('adb', runner), undefined).pressKeys(['cmd+a']).catch((x) => x)
    expect(e).toBeInstanceOf(UnsupportedOperationOnDevice)
    expect((e as Error).message).toContain('needs mobilecli')
    expect(runner.commands).toHaveLength(0)
  })

  it('android with mobilecli sends the keys through the avd name', async () => {
    const runner = new RecordingRunner((command) => (command.includes('emu') ? ok('Pixel_9\r\nOK\r\n') : ok('{"status":"ok"}')))
    await new AndroidSession(device, new AdbClient('adb', runner), undefined, 250, new MobilecliClient('mobilecli', runner)).pressKeys(['ctrl+a', 'backspace'])
    expect(runner.commands.at(-1)).toEqual(['mobilecli', 'io', 'keys', '--device', 'Pixel_9', 'ctrl+a', 'backspace'])
  })
})
