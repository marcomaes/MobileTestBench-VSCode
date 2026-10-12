// ported-from: test:core/DevicePowerTest.kt
import { describe, expect, it } from 'vitest'
import { AdbClient } from '../../src/core/android/adbClient'
import { DeviceDiscovery } from '../../src/core/discovery/deviceDiscovery'
import { CommandNotFoundException, CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { MobilecliException } from '../../src/core/mobilecliJson'
import { avdKey, displayName, isSameDevice, isUsable, makeDevice } from '../../src/core/model'
import { OfflineDevices, Polling, PowerActions } from '../../src/core/power/devicePower'
import { fixture } from '../helpers/fixtures'

const runningIos = makeDevice({ id: 'F2368465-C17E-4E1D-B270-D9433E8A6622', name: 'iPhone 17 Pro', platform: 'IOS', kind: 'SIMULATOR', osVersion: 'iOS 26.5', state: 'Booted' })
const runningAndroid = makeDevice({ id: 'emulator-5554', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', osVersion: 'Android 17', state: 'device', avdName: 'Pixel_9' })

/** Records the last command and timeout, answers with a canned result. */
class Fake extends CommandRunner {
  command: string[] | undefined
  timeoutMs: number | undefined
  constructor(
    private readonly stdout: string,
    private readonly exit = 0,
    private readonly stderr = '',
  ) {
    super()
  }
  override async run(command: string[], timeoutMs = 20_000): Promise<CommandResult> {
    this.command = command
    this.timeoutMs = timeoutMs
    return new CommandResult(this.exit, Buffer.from(this.stdout), this.stderr)
  }
}

describe('DevicePowerTest', () => {
  it('parsesOnlyOfflineEntries', () => {
    const offline = OfflineDevices.parse(fixture('mobilecli-devices-include-offline.json'))
    expect(offline).toHaveLength(1)
    const d = offline[0]
    expect(d.id).toBe('33915C06-CAF3-430C-9607-AFD7B6AAF75E')
    expect(d.name).toBe('iPhone 18 Pro')
    expect(d.kind).toBe('SIMULATOR')
    expect(d.osVersion).toBe('iOS 27.0')
    expect(d.bootable).toBe(true)
    expect(isUsable(d)).toBe(false)
    expect(displayName(d).endsWith('(offline)')).toBe(true)
  })

  it('offlineAvdKeepsIdAndNamePieces', () => {
    const json = `{"status":"ok","data":{"devices":[{"id":"Scout_Tmp","name":"Scout Tmp","platform":"android","type":"emulator","version":"16.0","state":"offline","model":""},
            {"id":"X","name":"Real","platform":"ios","type":"real","state":"offline"},{"id":"","name":"x","platform":"ios","type":"simulator","state":"offline"}]}}`
    const list = OfflineDevices.parse(json)
    expect(list).toHaveLength(1)
    const d = list[0]
    expect(d.id).toBe('Scout_Tmp')
    expect(d.name).toBe('Scout Tmp')
    expect(d.osVersion).toBe('Android 16.0')
    expect(avdKey(d)).toBe('Scout_Tmp')
  })

  it('errorEnvelopeAndEmptyData', () => {
    let thrown: unknown
    try {
      OfflineDevices.parse(fixture('mobilecli-device-notfound-error.json'))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MobilecliException)
    expect((thrown as Error).message).toContain('device not found')
    expect(OfflineDevices.parse('{"status":"ok","data":{}}')).toHaveLength(0)
  })

  it('runningAvdIsNotListedAgainAsOffline', () => {
    const json = `{"status":"ok","data":{"devices":[{"id":"Pixel_9","name":"Pixel 9","platform":"android","type":"emulator","version":"17","state":"offline"},
            {"id":"Small","name":"Small","platform":"android","type":"emulator","version":"16","state":"offline"}]}}`
    expect(OfflineDevices.missingFrom([runningAndroid, runningIos], json).map((d) => d.id)).toEqual(['Small'])
  })

  it('runningSimulatorIsNotListedAgain', () => {
    expect(OfflineDevices.missingFrom([runningIos], fixture('mobilecli-devices-include-offline.json')).map((d) => d.name)).toEqual(['iPhone 18 Pro'])
  })

  it('availabilityFollowsState', () => {
    const offline = OfflineDevices.parse(fixture('mobilecli-devices-include-offline.json'))[0]
    expect(PowerActions.isAvailableFor('BOOT', offline)).toBe(true)
    expect(PowerActions.isAvailableFor('SHUTDOWN', offline)).toBe(false)
    expect(PowerActions.isAvailableFor('REBOOT', offline)).toBe(false)
    expect(PowerActions.isAvailableFor('BOOT', runningIos)).toBe(false)
    expect(PowerActions.isAvailableFor('SHUTDOWN', runningAndroid)).toBe(true)
    expect(PowerActions.isAvailableFor('REBOOT', runningIos)).toBe(true)
    expect(PowerActions.isAvailableFor('BOOT', undefined)).toBe(false)
  })

  it('adbOfflineTransportIsNotBootable', () => {
    const adbOffline = makeDevice({ id: 'emulator-5554', name: 'emulator-5554', platform: 'ANDROID', kind: 'EMULATOR', state: 'offline' })
    expect(isUsable(adbOffline)).toBe(false)
    expect(PowerActions.isAvailableFor('BOOT', adbOffline)).toBe(false)
    expect(PowerActions.isAvailableFor('SHUTDOWN', adbOffline)).toBe(false)
    expect(displayName(adbOffline).endsWith('(offline)')).toBe(true)
  })

  it('physicalDevicesHaveNoPower', () => {
    const phone = makeDevice({ id: 'R5CT', name: 'Galaxy', platform: 'ANDROID', kind: 'PHYSICAL', state: 'device' })
    expect(PowerActions.isAvailableFor('SHUTDOWN', phone)).toBe(false)
  })

  it('sameDeviceMatchesAvdAcrossSerials', () => {
    const offline = makeDevice({ id: 'Pixel_9', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', state: 'offline', bootable: true })
    expect(isSameDevice(offline, runningAndroid)).toBe(true)
    expect(isSameDevice(runningAndroid, { ...runningAndroid, id: 'emulator-5556' })).toBe(true)
    expect(isSameDevice(runningAndroid, { ...runningAndroid, id: 'emulator-5556', avdName: 'Other' })).toBe(false)
    expect(isSameDevice(runningAndroid, runningIos)).toBe(false)
  })

  it('commandsAndTimeouts', () => {
    expect(PowerActions.args('BOOT')).toEqual(['device', 'boot'])
    expect(PowerActions.args('SHUTDOWN')).toEqual(['device', 'shutdown'])
    expect(PowerActions.args('REBOOT')).toEqual(['device', 'reboot'])
    expect(PowerActions.timeoutMs('BOOT')).toBeGreaterThan(20_000)
    expect(PowerActions.needsConfirmation('BOOT')).toBe(false)
    expect(PowerActions.needsConfirmation('SHUTDOWN') && PowerActions.needsConfirmation('REBOOT')).toBe(true)
  })

  it('bootCallBuildsCommandLineAndUsesLongTimeout', async () => {
    const runner = new Fake(fixture('mobilecli-device-boot-ok.json'))
    await new MobilecliClient('mobilecli', runner).call('33915C06', PowerActions.args('BOOT'), PowerActions.timeoutMs('BOOT'))
    expect(runner.command).toEqual(['mobilecli', 'device', 'boot', '--device', '33915C06'])
    expect(runner.timeoutMs).toBe(120_000)
  })

  it('bootOfRunningDeviceSurfacesMobilecliText', async () => {
    const runner = new Fake(fixture('mobilecli-device-boot-error-running.json'), 1, 'plain')
    const e = await new MobilecliClient('mobilecli', runner).call('x', PowerActions.args('BOOT')).catch((x) => x)
    expect(e).toBeInstanceOf(MobilecliException)
    expect((e as Error).message).toContain('simulator is already running')
  })

  it('shutdownOfOfflineDeviceSurfacesMobilecliText', async () => {
    const runner = new Fake(fixture('mobilecli-device-shutdown-error-offline.json'), 1)
    const e = await new MobilecliClient('mobilecli', runner).call('x', PowerActions.args('SHUTDOWN')).catch((x) => x)
    expect(e).toBeInstanceOf(MobilecliException)
    expect((e as Error).message).toContain('already offline')
  })

  it('offlineListingCommand', async () => {
    const runner = new Fake(fixture('mobilecli-devices-include-offline.json'))
    await new MobilecliClient('mobilecli', runner).devicesIncludingOfflineJson()
    expect(runner.command).toEqual(['mobilecli', 'devices', '--include-offline'])
  })

  it('pollingFindsDeviceAfterSomeRounds', async () => {
    let clock = 0
    let calls = 0
    const found = await Polling.until<string>({
      timeoutMs: 60_000,
      intervalMs: 2_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      probe: () => (++calls === 4 ? 'up' : undefined),
    })
    expect(found).toBe('up')
    expect(clock).toBe(6_000)
  })

  it('pollingTimesOutAndIgnoresProbeErrors', async () => {
    let clock = 0
    const found = await Polling.until<string>({
      timeoutMs: 10_000,
      intervalMs: 2_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      probe: () => {
        throw new Error('adb down')
      },
    })
    expect(found).toBeUndefined()
    expect(clock).toBe(10_000)
  })

  it('pollingStopsWhenCancelled', async () => {
    let calls = 0
    const found = await Polling.until<string>({
      timeoutMs: 60_000,
      intervalMs: 1,
      sleep: async () => {},
      cancelled: () => calls >= 2,
      probe: () => {
        calls++
        return undefined
      },
    })
    expect(found).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('usableMatchSkipsStillOfflineEntry', () => {
    const offline = makeDevice({ id: 'Pixel_9', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', state: 'offline', bootable: true })
    expect(Polling.usableMatch([offline], offline)).toBeUndefined()
    expect(Polling.usableMatch([offline, runningAndroid], offline)).toBeDefined()
  })

  it('reselectPrefersUsableThenOfflineEntryOfSameAvd', () => {
    const offline = makeDevice({ id: 'Pixel_9', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', state: 'offline', bootable: true })
    // After shutting down emulator-5554 only the offline entry is left: it must stay selected, not the first device.
    expect(Polling.reselect([runningIos, offline], runningAndroid)).toEqual(offline)
    // A usable match wins over an offline one.
    const rebooted = { ...runningAndroid, id: 'emulator-5556' }
    expect(Polling.reselect([offline, rebooted], runningAndroid)).toEqual(rebooted)
    expect(Polling.reselect([runningIos], runningAndroid)).toBeUndefined()
    expect(Polling.reselect([runningIos], undefined)).toBeUndefined()
  })

  it('parseOfNonJsonIsEmpty', () => {
    expect(OfflineDevices.parse('not json at all')).toHaveLength(0)
    expect(OfflineDevices.parse('')).toHaveLength(0)
  })

  /** Answers `adb devices -l` with one emulator and `mobilecli devices --include-offline` with [offlineStdout]. */
  class DiscoveryFake extends CommandRunner {
    constructor(
      private readonly offlineStdout: string,
      private readonly offlineExit = 0,
    ) {
      super()
    }
    override async run(command: string[]): Promise<CommandResult> {
      if (command[0] === 'adb' && command.includes('devices')) {
        return new CommandResult(0, Buffer.from('List of devices attached\nemulator-5554          device product:sdk model:sdk_gphone device:emu transport_id:1\n\n'), '')
      }
      if (command[0] === 'mobilecli' && command.includes('--include-offline')) return new CommandResult(this.offlineExit, Buffer.from(this.offlineStdout), 'boom')
      return new CommandResult(1, Buffer.alloc(0), 'unexpected')
    }
  }

  const discover = (runner: CommandRunner) => new DeviceDiscovery(new AdbClient('adb', runner), undefined, new MobilecliClient('mobilecli', runner)).discover()

  it('discoveryAppendsOfflineEntriesAfterOnlineOnes', async () => {
    const json = '{"status":"ok","data":{"devices":[{"id":"Small","name":"Small","platform":"android","type":"emulator","version":"16","state":"offline"}]}}'
    const result = await discover(new DiscoveryFake(json))
    expect(result.devices.map((d) => d.id)).toEqual(['emulator-5554', 'Small'])
    expect(result.devices.at(-1)!.bootable).toBe(true)
  })

  it('discoveryExplainsAMissingAdb', async () => {
    const runner = new (class extends CommandRunner {
      override async run(): Promise<CommandResult> {
        throw new CommandNotFoundException('/nonexistent/adb', 'spawn /nonexistent/adb ENOENT')
      }
    })()
    const result = await new DeviceDiscovery(new AdbClient('/nonexistent/adb', runner), undefined).discover()
    expect(result.devices).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('adb was not found (/nonexistent/adb)')
  })

  it('discoveryKeepsOnlineDevicesWhenOfflineListingFails', async () => {
    const failed = await discover(new DiscoveryFake('', 1))
    expect(failed.devices.map((d) => d.id)).toEqual(['emulator-5554'])
    expect(failed.warnings.some((w) => w.startsWith('Offline devices'))).toBe(true)
    const garbage = await discover(new DiscoveryFake('garbage output'))
    expect(garbage.devices.map((d) => d.id)).toEqual(['emulator-5554'])
  })
})
