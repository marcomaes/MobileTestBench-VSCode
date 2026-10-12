// ported-from: test:core/BiometricsTest.kt
import { describe, expect, it } from 'vitest'
import { AndroidBiometrics, BiometricCommands, EmuReply, IosBiometrics } from '../../src/core/biometrics/biometrics'
import { CommandFailedException, CommandResult } from '../../src/core/exec/commandRunner'
import { fixture } from '../helpers/fixtures'
import { ok, RecordingRunner } from '../helpers/fakeRunner'

const failure = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected failure')
}

describe('BiometricsTest', () => {
  it('biometryFromModelName', () => {
    const cases: Array<[string, 'FACE_ID' | 'TOUCH_ID']> = [
      ['iPhone 17 Pro', 'FACE_ID'],
      ['iPhone X', 'FACE_ID'],
      ['iPhone 15 Pro', 'FACE_ID'],
      ['iPhone SE (3rd generation)', 'TOUCH_ID'],
      ['iPhone 8', 'TOUCH_ID'],
      ['iPhone 7 Plus', 'TOUCH_ID'],
      ['iPad (10th generation)', 'TOUCH_ID'],
      ['iPad Pro 13-inch (M4)', 'FACE_ID'],
      ['iPad Pro (9.7-inch)', 'TOUCH_ID'],
      ['iPhone 6s Plus', 'TOUCH_ID'],
      ['iPhone 6s', 'TOUCH_ID'],
      ['iPad Pro (11-inch) (1st generation)', 'FACE_ID'],
      ['iPad Pro (12.9-inch) (1st generation)', 'TOUCH_ID'],
      ['iPad Pro (12.9-inch) (2nd generation)', 'TOUCH_ID'],
      ['iPad Pro (12.9-inch) (3rd generation)', 'FACE_ID'],
      ['iPad Air', 'TOUCH_ID'],
    ]
    for (const [model, expected] of cases) expect(BiometricCommands.biometryFor(model), model).toBe(expected)
  })

  it('iosCommands', () => {
    const enroll = BiometricCommands.iosEnroll('xcrun', 'U')
    expect(enroll[0]).toEqual(['xcrun', 'simctl', 'spawn', 'U', 'notifyutil', '-s', 'com.apple.BiometricKit.enrollmentChanged', '1'])
    expect(enroll[1]).toEqual(['xcrun', 'simctl', 'spawn', 'U', 'notifyutil', '-p', 'com.apple.BiometricKit.enrollmentChanged'])
    expect(BiometricCommands.iosUnenroll('xcrun', 'U')[0].at(-1)).toBe('0')
    expect(BiometricCommands.iosMatch('xcrun', 'U', 'FACE_ID').at(-1)).toBe('com.apple.BiometricKit_Sim.pearl.match')
    expect(BiometricCommands.iosNoMatch('xcrun', 'U', 'FACE_ID').at(-1)).toBe('com.apple.BiometricKit_Sim.pearl.nomatch')
    expect(BiometricCommands.iosMatch('xcrun', 'U', 'TOUCH_ID').at(-1)).toBe('com.apple.BiometricKit_Sim.fingerTouch.match')
    expect(BiometricCommands.iosNoMatch('xcrun', 'U', 'TOUCH_ID').at(-1)).toBe('com.apple.BiometricKit_Sim.fingerTouch.nomatch')
  })

  it('enrollmentState', () => {
    expect(BiometricCommands.parseEnrollment('com.apple.BiometricKit.enrollmentChanged 0\n')).toBe(false)
    expect(BiometricCommands.parseEnrollment('com.apple.BiometricKit.enrollmentChanged 1')).toBe(true)
    expect(BiometricCommands.parseEnrollment('garbage')).toBeUndefined()
  })

  it('androidCommandsAndIdValidation', () => {
    expect(BiometricCommands.androidTouch('adb', 'emulator-5554', 3)).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'finger', 'touch', '3'])
    expect(BiometricCommands.androidLift('adb', 'emulator-5554')).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'finger', 'remove'])
    expect(BiometricCommands.parseFingerId(' 1 ')).toEqual([1, undefined])
    expect(BiometricCommands.parseFingerId('0')[0]).toBeUndefined()
    expect(BiometricCommands.parseFingerId('11')[0]).toBeUndefined()
    expect(BiometricCommands.parseFingerId('abc')[0]).toBeUndefined()
    expect(BiometricCommands.parseFingerId('')[0]).toBeUndefined()
    expect(() => BiometricCommands.androidTouch('adb', 's', 0)).toThrow()
  })

  it('emuReplyFromFixture', () => {
    const lines = fixture('android-emu-finger-outputs.txt').split(/\r\n|\r|\n/)
    expect(BiometricCommands.parseEmuReply(lines[0])).toEqual(EmuReply.Ok)
    expect(BiometricCommands.parseEmuReply(lines[1])).toEqual(EmuReply.Ko('invalid fingerid'))
    expect(BiometricCommands.parseEmuReply(lines[2])).toEqual(EmuReply.Ko('missing fingerid'))
    expect(BiometricCommands.parseEmuReply('some help text')).toBeUndefined()
    expect(BiometricCommands.parseEmuReply('')).toBeUndefined()
  })

  it('fingerprintDumpFromFixture', () => {
    const text = fixture('android-dumpsys-fingerprint-none.txt')
    expect(BiometricCommands.parseFingerprintDump(text)).toEqual([{ id: 0, count: 0, accept: 0, reject: 0 }])
    expect(BiometricCommands.enrolledCount(text)).toBe(0)
    const enrolled = '{"service":"x","prints":[{"id":0,"count":2,"accept":5,"reject":1,"acquire":0}]}'
    expect(BiometricCommands.enrolledCount(enrolled)).toBe(2)
    expect(BiometricCommands.enrolledCount('no json here')).toBeUndefined()
  })

  it('iosActionsRunInOrderAndReportFailure', async () => {
    const runner = new RecordingRunner(() => ok())
    const ios = new IosBiometrics('xcrun', 'U', runner)
    await ios.enroll()
    expect(runner.commands.map((c) => c[5])).toEqual(['-s', '-p'])
    expect((await ios.match('FACE_ID')).text).toContain('pearl.match')
    expect((await ios.noMatch('TOUCH_ID')).error).toBe(false)

    const failing = new IosBiometrics('xcrun', 'U', new RecordingRunner(() => new CommandResult(148, Buffer.alloc(0), 'Invalid device: U')))
    const e = await failure(failing.unenroll())
    expect(e).toBeInstanceOf(CommandFailedException)
    expect(e.message).toBe('Invalid device: U')
    expect(await failing.readEnrolled()).toBeUndefined()
  })

  it('androidTouchReportsOkAndKoAndAdbFailure', async () => {
    const result = await new AndroidBiometrics('adb', 'emulator-5554', new RecordingRunner(() => ok('OK\n'))).touch(1)
    expect(result.error).toBe(false)
    expect(result.text).toContain('does not mean authentication succeeded')

    const ko = await new AndroidBiometrics('adb', 'emulator-5554', new RecordingRunner(() => ok('KO: invalid fingerid\n'))).touch(1)
    expect(ko.error).toBe(true)
    expect(ko.text).toContain('invalid fingerid')

    const adbFail = new AndroidBiometrics('adb', 'emulator-5554', new RecordingRunner(() => new CommandResult(1, Buffer.alloc(0), "error: device 'emulator-5554' not found")))
    expect((await failure(adbFail.lift())).message).toContain('not found')
  })
})
