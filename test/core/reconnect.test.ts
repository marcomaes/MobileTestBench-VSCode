// ported-from: test:core/ReconnectTest.kt
import { describe, expect, it } from 'vitest'
import { makeDevice, type Device } from '../../src/core/model'
import { ReconnectEvents, ReconnectWatcher } from '../../src/core/reconnect/reconnect'

const pixel = makeDevice({ id: 'emulator-5554', name: 'Pixel_9', platform: 'ANDROID', kind: 'EMULATOR', state: 'device', avdName: 'Pixel_9' })
const iphone = makeDevice({ id: 'UDID-1', name: 'iPhone 17 Pro', platform: 'IOS', kind: 'SIMULATOR', state: 'Booted' })

function setup() {
  const s = { devices: [] as Device[] | undefined, now: 0 }
  const watcher = new ReconnectWatcher(() => s.devices, () => s.now)
  return { s, watcher }
}

describe('ReconnectTest', () => {
  it('staysConnectedWhileListed', async () => {
    const { s, watcher } = setup()
    s.devices = [pixel]
    watcher.watch(pixel)
    for (let i = 0; i < 5; i++) expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.phase).toBe('CONNECTED')
  })

  it('oneMissingPollIsNotEnough', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    s.devices = []
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    s.devices = [pixel]
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    s.devices = []
    // the miss counter was reset by the good poll
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.phase).toBe('CONNECTED')
  })

  it('twoMissingPollsInARowMeanLost', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    s.devices = []
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(await watcher.tick()).toEqual(ReconnectEvents.lost(pixel))
    expect(watcher.phase).toBe('WAITING')
  })

  it('unusableCountsAsMissing', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    s.devices = [{ ...pixel, state: 'offline' }]
    await watcher.tick()
    expect((await watcher.tick()).kind).toBe('Lost')
    // a bootable offline entry is not usable either
    watcher.watch(pixel)
    s.devices = [{ ...pixel, id: 'Pixel_9', state: 'offline', bootable: true }]
    await watcher.tick()
    expect((await watcher.tick()).kind).toBe('Lost')
  })

  it('inconclusiveDiscoveryChangesNothing', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    s.devices = undefined
    for (let i = 0; i < 4; i++) expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.phase).toBe('CONNECTED')
  })

  it('discoveryWithWarningsAndNoTargetIsInconclusive', async () => {
    const { s, watcher } = setup()
    const failed = { devices: [], warnings: ['Android: adb timed out'] }
    expect(ReconnectWatcher.conclusive(failed, pixel)).toBeUndefined()
    expect(ReconnectWatcher.conclusive({ devices: [], warnings: [] }, pixel)).toEqual([])
    const partial = { devices: [pixel], warnings: ['iOS: simctl failed'] }
    expect(ReconnectWatcher.conclusive(partial, pixel)).toEqual([pixel])
    // failed polls in a row never make the watcher give up
    s.devices = undefined
    watcher.watch(pixel)
    for (let i = 0; i < 4; i++) expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.phase).toBe('CONNECTED')
  })

  it('throwingDiscoveryIsInconclusive', async () => {
    const w = new ReconnectWatcher(() => {
      throw new Error('adb died')
    })
    w.watch(pixel)
    for (let i = 0; i < 3; i++) expect(await w.tick()).toEqual(ReconnectEvents.None)
    expect(w.phase).toBe('CONNECTED')
  })

  it('sessionErrorPlusOneMissingPollIsLost', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    watcher.sessionFailed()
    s.devices = []
    expect(await watcher.tick()).toEqual(ReconnectEvents.lost(pixel))
  })

  it('sessionErrorAloneDoesNotLoseAListedDevice', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    watcher.sessionFailed()
    s.devices = [pixel]
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    s.devices = []
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
  })

  it('reconnectsWhenSameDeviceIsBack', async () => {
    const { s, watcher } = setup()
    watcher.watch(iphone)
    s.devices = []
    await watcher.tick()
    await watcher.tick()
    s.now = 5_000
    expect(await watcher.tick()).toEqual(ReconnectEvents.stillWaiting(iphone, 5_000))
    s.devices = [pixel]
    expect((await watcher.tick()).kind).toBe('StillWaiting')
    s.devices = [pixel, iphone]
    expect(await watcher.tick()).toEqual(ReconnectEvents.reconnected(iphone))
    expect(watcher.phase).toBe('IDLE')
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
  })

  it('emulatorWithNewSerialIsTheSameDevice', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    s.devices = []
    await watcher.tick()
    await watcher.tick()
    const rebooted = { ...pixel, id: 'emulator-5556' }
    s.devices = [rebooted]
    expect(await watcher.tick()).toEqual(ReconnectEvents.reconnected(rebooted))
  })

  it('waitingIgnoresOfflineEntryOfTheSameDevice', async () => {
    const { s, watcher } = setup()
    watcher.waitFor(pixel)
    s.devices = [{ ...pixel, id: 'Pixel_9', state: 'offline', bootable: true }]
    expect((await watcher.tick()).kind).toBe('StillWaiting')
    expect(watcher.phase).toBe('WAITING')
  })

  it('backoffGrowsFromThreeToTenSeconds', async () => {
    const { s, watcher } = setup()
    expect(watcher.pollDelayMs()).toBe(3_000)
    watcher.watch(pixel)
    expect(watcher.pollDelayMs()).toBe(3_000)
    s.devices = []
    await watcher.tick()
    await watcher.tick()
    const delays = [watcher.pollDelayMs()]
    for (let i = 0; i < 10; i++) {
      await watcher.tick()
      delays.push(watcher.pollDelayMs())
    }
    expect(delays).toEqual([3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 10_000, 10_000, 10_000])
  })

  it('noTimeLimit', async () => {
    const { s, watcher } = setup()
    watcher.waitFor(pixel)
    s.devices = []
    s.now = 24 * 3_600_000
    expect((await watcher.tick()).kind).toBe('StillWaiting')
    expect(watcher.phase).toBe('WAITING')
  })

  it('stopCancelsEverything', async () => {
    const { s, watcher } = setup()
    watcher.watch(pixel)
    watcher.stop()
    s.devices = []
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.target).toBeUndefined()
    watcher.waitFor(pixel)
    watcher.stop()
    s.devices = [pixel]
    expect(await watcher.tick()).toEqual(ReconnectEvents.None)
    expect(watcher.phase).toBe('IDLE')
  })

  it('answerForAReplacedTargetIsDropped', async () => {
    // discovery runs while the user picks another device: the old answer must not mark the new one lost
    const w: ReconnectWatcher = new ReconnectWatcher(() => {
      w.watch(iphone)
      return []
    })
    w.watch(pixel)
    expect(await w.tick()).toEqual(ReconnectEvents.None)
    expect(w.target).toBe(iphone)
    expect(w.phase).toBe('CONNECTED')
  })

  it('waitForGoesStraightToWaitingAndReconnects', async () => {
    const { s, watcher } = setup()
    s.now = 100
    watcher.waitFor(iphone)
    expect(watcher.phase).toBe('WAITING')
    s.now = 4_100
    expect(watcher.waitedMs()).toBe(4_000)
    s.devices = [iphone]
    expect(await watcher.tick()).toEqual(ReconnectEvents.reconnected(iphone))
  })

  it('waitingText', () => {
    expect(ReconnectWatcher.waitingText(pixel, 3_000)).toBe('Waiting for Pixel_9 to come back...')
    expect(ReconnectWatcher.waitingText(pixel, 12_500)).toBe('Waiting for Pixel_9 to come back... (12 s)')
  })
})
