// ported-from: test:core/NetworkTest.kt
import { describe, expect, it } from 'vitest'
import { CommandResult } from '../../src/core/exec/commandRunner'
import {
  AndroidNetwork,
  EmuNetworkStatus,
  NetworkActions,
  NetworkCommands,
  NetworkParsers,
  NetworkReset,
  type NetworkChange,
  type NetworkState,
} from '../../src/core/network/network'
import { fixture } from '../helpers/fixtures'
import { ok, RecordingRunner } from '../helpers/fakeRunner'

const S = (d: number, u: number, min: number, max: number) => new EmuNetworkStatus(d, u, min, max)

function backend(answer: (cmd: string[]) => string, emulator = true): [AndroidNetwork, RecordingRunner] {
  const runner = new RecordingRunner((c) => ok(answer(c)))
  return [new AndroidNetwork('adb', 'emulator-5554', runner, emulator), runner]
}

const state = (o: { airplane?: boolean; wifi?: boolean; data?: boolean; emu?: EmuNetworkStatus | null } = {}): NetworkState => ({
  airplane: o.airplane ?? false,
  wifi: o.wifi ?? true,
  mobileData: o.data ?? true,
  online: true,
  emulator: o.emu === null ? undefined : (o.emu ?? S(0, 0, 0, 0)),
})

const message = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected an error')
}

describe('NetworkTest', () => {
  it('parsesStatusFixtures', () => {
    expect(NetworkParsers.emuStatus(fixture('android-emu-network-status-full.txt'))).toEqual(S(0, 0, 0, 0))
    expect(NetworkParsers.emuStatus(fixture('android-emu-network-status-edge.txt'))).toEqual(S(473600, 473600, 80, 400))
    expect(NetworkParsers.emuStatus(fixture('android-emu-network-status-custom.txt'))).toEqual(S(200000, 100000, 150, 400))
    expect(NetworkParsers.emuStatus(fixture('android-emu-network-help.txt'))).toBeUndefined()
  })

  it('findsKoLinesIgnoringNoise', () => {
    expect(NetworkParsers.emuError(fixture('android-emu-network-speed-error.txt'))).toBe("invalid <speed> argument, see 'help network speed' for valid values")
    expect(NetworkParsers.emuError(fixture('android-emu-network-help.txt'))).toBe('missing sub-command')
    expect(NetworkParsers.emuError('Warning: time of day goes back (1) taking countermeasures.\nOK\n')).toBeUndefined()
    expect(NetworkParsers.emuError(fixture('android-emu-network-status-edge.txt'))).toBeUndefined()
  })

  it('parsesSwitches', () => {
    expect(NetworkParsers.airplane('disabled\n')).toBe(false)
    expect(NetworkParsers.airplane('enabled')).toBe(true)
    expect(NetworkParsers.airplane('1\n')).toBe(true)
    expect(NetworkParsers.airplane('null')).toBeUndefined()
    expect(NetworkParsers.wifi(fixture('android-wifi-status-enabled.txt'))).toBe(true)
    expect(NetworkParsers.wifi('Wifi is disabled\nWifi scanning is only available when wifi is enabled\n')).toBe(false)
    expect(NetworkParsers.wifi('Error: nope')).toBeUndefined()
    expect(NetworkParsers.mobileData('1\n')).toBe(true)
    expect(NetworkParsers.mobileData('0')).toBe(false)
    expect(NetworkParsers.mobileData('null')).toBeUndefined()
  })

  it('parsesDefaultNetwork', () => {
    expect(NetworkParsers.online('Active default network: 100\n')).toBe(true)
    expect(NetworkParsers.online('Active default network: none\n')).toBe(false)
    expect(NetworkParsers.online('')).toBeUndefined()
  })

  it('matchesPresetsAndPrefersTheChosenOne', () => {
    const full = S(0, 0, 0, 0)
    expect(NetworkParsers.matchSpeed(full)).toBe('FULL')
    expect(NetworkParsers.matchSpeed(full, 'G5')).toBe('G5')
    expect(NetworkParsers.matchSpeed(S(473600, 473600, 80, 400))).toBe('EDGE')
    expect(NetworkParsers.matchSpeed(S(200000, 100000, 150, 400))).toBeUndefined()
    expect(NetworkParsers.matchDelay(S(0, 0, 80, 400))).toBe('EDGE')
    expect(NetworkParsers.matchDelay(S(0, 0, 35, 200), 'UMTS')).toBe('UMTS')
    expect(NetworkParsers.matchDelay(S(0, 0, 35, 200))).toBe('GPRS')
    expect(NetworkParsers.matchDelay(S(0, 0, 150, 400))).toBeUndefined()
  })

  it('describesStatus', () => {
    expect(S(0, 0, 0, 0).describe()).toBe('unlimited speed, no delay')
    expect(S(473600, 473600, 80, 400).describe()).toBe('473600 bits/s down, 473600 bits/s up, 80-400 ms')
  })

  it('buildsCommands', () => {
    const c = new NetworkCommands('adb', 'emulator-5554')
    expect(c.airplane(true)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'])
    expect(c.wifi(false)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'svc', 'wifi', 'disable'])
    expect(c.mobileData(true)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'svc', 'data', 'enable'])
    expect(c.speed('edge')).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'network', 'speed', 'edge'])
    expect(c.delay('none')).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'network', 'delay', 'none'])
  })

  it('readsEverything', async () => {
    const [net] = backend((cmd) => {
      const line = cmd.slice(3).join(' ')
      if (line.includes('airplane-mode')) return 'disabled\n'
      if (line.includes('wifi status')) return fixture('android-wifi-status-enabled.txt')
      if (line.includes('mobile_data')) return '1\n'
      if (line.includes('dumpsys')) return 'Active default network: 100\n'
      return fixture('android-emu-network-status-edge.txt')
    })
    const s = await net.read()
    expect(s.airplane).toBe(false)
    expect(s.wifi).toBe(true)
    expect(s.mobileData).toBe(true)
    expect(s.online).toBe(true)
    expect(s.emulator).toEqual(S(473600, 473600, 80, 400))
    expect(Object.keys(s.errors ?? {})).toHaveLength(0)
  })

  it('readFallsBackToSettingAndKeepsOtherPartsOnError', async () => {
    const [net] = backend((cmd) => {
      const line = cmd.slice(3).join(' ')
      if (line.includes('cmd connectivity')) return "cmd: Can't find service: connectivity\n"
      if (line.includes('airplane_mode_on')) return '1\n'
      if (line.includes('wifi status')) return 'garbage\n'
      if (line.includes('mobile_data')) return '0\n'
      return ''
    }, false)
    const s = await net.read()
    expect(s.airplane).toBe(true)
    expect(s.wifi).toBeUndefined()
    expect(s.errors!.wifi).toBe('Wi-Fi state unknown')
    expect(s.mobileData).toBe(false)
    expect(s.emulator).toBeUndefined()
  })

  it('consoleKoIsAnErrorEvenWithExitCodeZero', async () => {
    const [net] = backend(() => fixture('android-emu-network-speed-error.txt'))
    expect((await message(net.setSpeed('bogus'))).startsWith('invalid <speed> argument')).toBe(true)
  })

  it('nonZeroExitIsAnError', async () => {
    const net = new AndroidNetwork('adb', 'emulator-5554', new RecordingRunner(() => new CommandResult(1, Buffer.alloc(0), 'adb: device offline\n')), true)
    expect(await message(net.setWifi(false))).toBe('adb: device offline')
  })

  it('resetWithoutBaselineGoesToNormal', () => {
    const now = state({ airplane: true, wifi: false, data: false, emu: S(14400, 14400, 80, 400) })
    const plan = NetworkReset.plan(undefined, now, true)
    expect(plan).toEqual<NetworkChange[]>([
      { key: 'AIRPLANE', on: false },
      { key: 'WIFI', on: true },
      { key: 'DATA', on: true },
      { key: 'SPEED', arg: 'full' },
      { key: 'DELAY', arg: 'none' },
    ])
    expect(NetworkReset.plan(undefined, state(), true)).toHaveLength(0)
  })

  it('resetRestoresOriginalsOnlyWhereDifferent', () => {
    const original = state({ wifi: false, emu: S(473600, 473600, 80, 400) })
    const now = state({ wifi: false, data: false, emu: S(14400, 14400, 80, 400) })
    expect(NetworkReset.plan(original, now, true)).toEqual<NetworkChange[]>([
      { key: 'DATA', on: true },
      { key: 'SPEED', arg: 'edge' },
    ])
  })

  it('resetOfCustomSpeedUsesKbitUpDown', () => {
    expect(NetworkReset.speedArg(S(200000, 100000, 150, 400))).toBe('100:200')
    expect(NetworkReset.delayArg(S(200000, 100000, 150, 400))).toBe('150:400')
  })

  it('resetPutsAirplaneLastWhenItWasOn', () => {
    const plan = NetworkReset.plan(state({ airplane: true, wifi: false }), state({ airplane: false, wifi: true }), false)
    expect(plan).toEqual<NetworkChange[]>([
      { key: 'WIFI', on: false },
      { key: 'AIRPLANE', on: true },
    ])
  })

  it('emulatorPartSkippedForDevices', () => {
    expect(NetworkReset.plan(undefined, state({ emu: null }), false)).toHaveLength(0)
  })

  it('actionsRememberFirstStateAndClearOnSuccessfulReset', async () => {
    let wifi = true
    const [net, runner] = backend((cmd) => {
      const line = cmd.slice(3).join(' ')
      if (line.includes('svc wifi')) {
        wifi = line.endsWith('enable')
        return ''
      }
      if (line.includes('airplane-mode')) return 'disabled\n'
      if (line.includes('wifi status')) return wifi ? 'Wifi is enabled\n' : 'Wifi is disabled\n'
      if (line.includes('mobile_data')) return '1\n'
      return ''
    }, false)
    const actions = new NetworkActions()
    const before = state({ emu: null })
    expect(await actions.change('d', net, before, [{ key: 'WIFI', on: false }])).toBeUndefined()
    expect(actions.baseline.originals('d')).toEqual(before)
    // a second change must not overwrite the remembered original
    await actions.change('d', net, state({ wifi: false, emu: null }), [{ key: 'DATA', on: false }])
    expect(actions.baseline.originals('d')).toEqual(before)
    const [failure, restored] = await actions.reset('d', net)
    expect(failure).toBeUndefined()
    expect(restored).toBe(true)
    expect(actions.baseline.originals('d')).toBeUndefined()
    expect(runner.commands.some((c) => c.includes('svc') && c.includes('wifi') && c.at(-1) === 'enable')).toBe(true)
    expect(wifi).toBe(true)
  })

  it('javaExceptionOnStdoutIsAnErrorEvenWithExitCodeZero', async () => {
    const [net] = backend(() => 'java.lang.IllegalArgumentException: bad\n', false)
    expect(await message(net.setWifi(false))).toContain('IllegalArgumentException')
  })

  it('failedFirstWriteLeavesNoBaselineAndLaterChangesDoNotRun', async () => {
    const [net, runner] = backend(() => 'Error: refused\n', false)
    const actions = new NetworkActions()
    const failure = await actions.change('d', net, state({ emu: null }), [{ key: 'WIFI', on: false }, { key: 'DATA', on: false }])
    expect(failure).toContain('refused')
    expect(actions.baseline.originals('d')).toBeUndefined()
    expect(runner.commands).toHaveLength(1)
  })

  it('laterFailureKeepsBaselineAndStops', async () => {
    let n = 0
    const [net, runner] = backend(() => (++n === 2 ? 'Exception: no\n' : ''), false)
    const actions = new NetworkActions()
    const before = state({ emu: null })
    const changes: NetworkChange[] = [{ key: 'WIFI', on: false }, { key: 'DATA', on: false }, { key: 'AIRPLANE', on: true }]
    expect(await actions.change('d', net, before, changes)).toContain('Exception')
    expect(actions.baseline.originals('d')).toEqual(before)
    expect(runner.commands).toHaveLength(2)
  })

  it('failedResetKeepsBaseline', async () => {
    const [net] = backend((cmd) => {
      const line = cmd.slice(3).join(' ')
      if (line.includes('svc')) return 'Error: refused\n'
      if (line.includes('airplane-mode')) return 'disabled\n'
      if (line.includes('wifi status')) return 'Wifi is disabled\n'
      if (line.includes('mobile_data')) return '1\n'
      return ''
    }, false)
    const actions = new NetworkActions()
    actions.baseline.remember('d', state({ emu: null }))
    const [failure] = await actions.reset('d', net)
    expect(failure).toBeDefined()
    expect(actions.baseline.originals('d')).toBeDefined()
  })
})
