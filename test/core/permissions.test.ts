// ported-from: test:core/PermissionsTest.kt
import { describe, expect, it } from 'vitest'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import {
  AndroidPermissions,
  IosPermissions,
  IosPrivacyActions,
  IosPrivacyServices,
  iosPrivacyServices,
  Permissions,
  RuntimePermission,
} from '../../src/core/permissions/permissions'
import { fixture } from '../helpers/fixtures'

class FakeRunner extends CommandRunner {
  readonly commands: string[][] = []
  constructor(private readonly answer: (command: string[]) => CommandResult) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command)
    return this.answer(command)
  }
}

const ok = (text = '') => new CommandResult(0, Buffer.from(text), '')
const fail = (code: number, stdout = '', stderr = '') => new CommandResult(code, Buffer.from(stdout), stderr)

describe('PermissionsTest', () => {
  it('parsesRuntimePermissionsFromRealDumpsys', () => {
    const set = Permissions.parseDumpsys(fixture('android-dumpsys-package-permissions.txt'))
    const camera = set.runtime.find((p) => p.name === 'android.permission.CAMERA')!
    expect(camera.granted).toBe(false)
    expect(camera.shortName).toBe('CAMERA')
    expect(camera.flags.has('USER_SET')).toBe(true)
    const fine = set.runtime.find((p) => p.name === 'android.permission.ACCESS_FINE_LOCATION')!
    expect(fine.granted).toBe(true)
    expect(fine.userFixed).toBe(true)
    expect(set.runtime.every((p) => p.name !== 'android.permission.INTERNET')).toBe(true)
    expect(set.runtime).toHaveLength(4)
    expect(set.installTimeCount).toBe(2)
  })

  it('parsesNoRuntimeSection', () => {
    const set = Permissions.parseDumpsys('Packages:\n  Package [x] (1):\n    install permissions:\n      android.permission.INTERNET: granted=true\n')
    expect(set.runtime).toEqual([])
    expect(set.installTimeCount).toBe(1)
  })

  it('permissionWithoutFlagsParses', () => {
    const set = Permissions.parseDumpsys('    User 0: x\n      runtime permissions:\n        android.permission.CAMERA: granted=true\n    other:\n')
    expect(set.runtime).toEqual([new RuntimePermission('android.permission.CAMERA', true)])
  })

  it('errorLinePrefersJavaExceptionLine', () => {
    const text = fixture('android-pm-grant-errors.txt').split(/\r?\n/)
    const stack = text.slice(2).reduce<{ out: string[]; stop: boolean }>((acc, l) => (acc.stop || l.startsWith('$') ? { ...acc, stop: true } : { out: [...acc.out, l], stop: false }), { out: [], stop: false }).out.join('\n')
    expect(Permissions.errorLine('', stack).startsWith('java.lang.SecurityException: Permission android.permission.INTERNET')).toBe(true)
    expect(Permissions.errorLine('Failure [package not found]\nError: package not found', '')).toBe('Failure [package not found]')
    expect(Permissions.errorLine('', '')).toBe('failed without output')
  })

  it('androidGrantAndRevokeBuildCommands', async () => {
    const runner = new FakeRunner(() => ok())
    const p = new AndroidPermissions('adb', 'emulator-5554', runner)
    expect((await p.grant('com.x', 'android.permission.CAMERA')).ok).toBe(true)
    expect((await p.revoke('com.x', 'android.permission.CAMERA')).ok).toBe(true)
    expect(runner.commands[0]).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'pm', 'grant', 'com.x', 'android.permission.CAMERA'])
    expect(runner.commands[1]).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'pm', 'revoke', 'com.x', 'android.permission.CAMERA'])
  })

  it('androidErrorUsesBothStreams', async () => {
    const r = await new AndroidPermissions('adb', 's', new FakeRunner(() => fail(1, 'Failure [package not found]\nError: package not found'))).grant('com.not.installed', 'android.permission.CAMERA')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Failure [package not found]')
    const r2 = await new AndroidPermissions('adb', 's', new FakeRunner(() => fail(255, '', "\nException occurred while executing 'grant':\njava.lang.SecurityException: not changeable\n\tat x.y"))).grant('com.x', 'android.permission.INTERNET')
    expect(r2.message).toBe('java.lang.SecurityException: not changeable')
  })

  it('androidRejectsUnsafeNames', async () => {
    const runner = new FakeRunner(() => ok())
    const r = await new AndroidPermissions('adb', 's', runner).grant('com.x; reboot', 'android.permission.CAMERA')
    expect(r.ok).toBe(false)
    expect(runner.commands).toEqual([])
  })

  it('resetAllRevokesAndClearsFlagsPerPermissionAndNeverUsesGlobalReset', async () => {
    const runner = new FakeRunner(() => ok())
    const perms = [new RuntimePermission('android.permission.CAMERA', true), new RuntimePermission('android.permission.ACCESS_FINE_LOCATION', false)]
    const results = await new AndroidPermissions('adb', 's', runner).resetAll('com.x', perms)
    expect(results).toHaveLength(6)
    expect(runner.commands.slice(0, 3).map((c) => c[5])).toEqual(['revoke', 'clear-permission-flags', 'clear-permission-flags'])
    expect(runner.commands.slice(1, 3).map((c) => c[c.length - 1])).toEqual(['user-set', 'user-fixed'])
    expect(runner.commands.every((c) => !c.includes('reset-permissions'))).toBe(true)
  })

  it('readParsesAndReportsFailure', async () => {
    const text = fixture('android-dumpsys-package-permissions.txt')
    expect((await new AndroidPermissions('adb', 's', new FakeRunner(() => ok(text))).read('com.x')).runtime).toHaveLength(4)
    await expect(new AndroidPermissions('adb', 's', new FakeRunner(() => fail(1, '', 'device offline'))).read('com.x')).rejects.toThrow('device offline')
  })

  it('iosCommandAlwaysCarriesBundleId', async () => {
    const runner = new FakeRunner(() => ok())
    const p = new IosPermissions('xcrun', 'UDID', runner)
    expect((await p.apply(IosPrivacyActions.RESET, IosPrivacyServices.ALL, 'com.x.app')).ok).toBe(true)
    expect(runner.commands[0]).toEqual(['xcrun', 'simctl', 'privacy', 'UDID', 'reset', 'all', 'com.x.app'])
    expect((await p.apply(IosPrivacyActions.RESET, IosPrivacyServices.CAMERA, '')).ok).toBe(false)
    expect(runner.commands).toHaveLength(1)
  })

  it('iosErrorShowsFirstLine', async () => {
    const usage = fixture('simctl-privacy-error-missing-bundle.txt').split(/\r?\n/).slice(1).join('\n')
    const r = await new IosPermissions('xcrun', 'U', new FakeRunner(() => fail(117, '', usage))).apply(IosPrivacyActions.GRANT, IosPrivacyServices.MICROPHONE, 'com.x')
    expect(r.ok).toBe(false)
    expect(r.message.trim().length > 0 && !r.message.includes('\n')).toBe(true)
  })

  it('iosServicesMatchSimctlHelp', () => {
    const line = fixture('simctl-privacy-help.txt').split(/\r?\n/).find((l) => l.trim().startsWith('service:'))!
    const listed = new Set(line.slice(line.indexOf('service:') + 'service:'.length).trim().split(/\s+/))
    expect(new Set(iosPrivacyServices().filter((s) => s.documented).map((s) => s.simctl))).toEqual(listed)
    expect(IosPrivacyServices.CAMERA.documented).toBe(false)
  })

  it('updatedSystemAppPrintedTwiceUsesFirstBlock', () => {
    const block = '  Package [x] (1):\n    User 0: x\n      runtime permissions:\n        android.permission.CAMERA: granted=true\n    other:\n'
    const set = Permissions.parseDumpsys(`Packages:\n${block}\nHidden system packages:\n` + block.replace('granted=true', 'granted=false'))
    expect(set.runtime).toEqual([new RuntimePermission('android.permission.CAMERA', true)])
  })

  it('exitZeroWithExceptionOrFailureLineIsAnError', async () => {
    const a = new AndroidPermissions('adb', 's', new FakeRunner(() => ok('java.lang.SecurityException: x\n\tat y')))
    const r = await a.grant('com.x', 'android.permission.CAMERA')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('java.lang.SecurityException: x')
    expect((await new AndroidPermissions('adb', 's', new FakeRunner(() => ok('Failure [nope]'))).revoke('com.x', 'android.permission.CAMERA')).ok).toBe(false)
  })

  it('resetAllKeepsClearingFlagsWhenRevokeFails', async () => {
    const runner = new FakeRunner((c) => (c.includes('revoke') ? fail(1, 'Failure [bad]') : ok()))
    const results = await new AndroidPermissions('adb', 's', runner).resetAll('com.x', [new RuntimePermission('android.permission.CAMERA', true)])
    expect(results.map((r) => r.ok)).toEqual([false, true, true])
    expect(runner.commands).toHaveLength(3)
  })
})
