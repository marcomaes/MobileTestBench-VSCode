// ported-from: test:core/AndroidSessionTest.kt
// ported-from: test:core/AndroidHierarchyFallbackTest.kt
import { describe, expect, it } from 'vitest'
import { AdbClient } from '../../src/core/android/adbClient'
import { AndroidSession } from '../../src/core/android/androidSession'
import type { EmulatorLink } from '../../src/core/android/emulatorLink'
import { CommandResult } from '../../src/core/exec/commandRunner'
import { MobilecliAndroidRawParser } from '../../src/core/inspector/hierarchyParsers'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { makeDevice, type DeviceKey } from '../../src/core/model'
import type { FrameListener } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'
import { fakeProcess, jpeg, png, ScriptedRunner, waitFor } from '../helpers/fakeProcess'

const ok = (data: Buffer | string = ''): CommandResult => new CommandResult(0, Buffer.from(data), '')

class FakeRunner extends ScriptedRunner {
  wmSize = 'Physical size: 1080x2400\n'
  constructor(stream?: Buffer, open = false) {
    const shot = png(1080, 2400)
    super(
      (command) => {
        if (command.includes('screencap')) return ok(shot)
        if (command.includes('wm')) return ok(this.wmSize)
        return ok()
      },
      () => {
        if (!stream) throw new Error('no stream')
        return fakeProcess(stream, open)
      },
    )
  }
}

class FailingLink implements EmulatorLink {
  closed = false
  startStreaming(listener: FrameListener) {
    listener.onError('UNAUTHENTICATED', undefined)
  }
  async tap() { throw new Error('should not be used') }
  async swipe() { throw new Error('should not be used') }
  async longPress() { throw new Error('should not be used') }
  async doubleTap() { throw new Error('should not be used') }
  async dragWithHold() { throw new Error('should not be used') }
  async press(_key: DeviceKey) { throw new Error('should not be used') }
  async typeText() { throw new Error('should not be used') }
  close() { this.closed = true }
}

const phone = makeDevice({ id: 'R3GL701H6WK', name: 'SM-F976B', platform: 'ANDROID', kind: 'PHYSICAL' })

function awaitFrame(session: AndroidSession, statuses: string[] = []): Promise<boolean> {
  let got = false
  session.start({
    onFrame: () => { got = true },
    onStatus: (m) => statuses.push(m),
    onError: () => {},
  })
  return waitFor(() => got)
}

describe('android session', () => {
  it('falls back to adb when the grpc link fails before the first frame', async () => {
    const runner = new FakeRunner()
    const link = new FailingLink()
    const device = makeDevice({ id: 'emulator-5554', name: 'Pixel', platform: 'ANDROID', kind: 'EMULATOR' })
    const session = new AndroidSession(device, new AdbClient('adb', runner), link, 50)
    expect(await awaitFrame(session)).toBe(true)
    expect(session.transport).toBe('adb screenshots')
    expect(link.closed).toBe(true)
    expect(session.logicalSize()).toEqual({ width: 1080, height: 2400 })
    await session.tap(10, 20)
    expect(runner.commands.some((c) => c.slice(-4).join() === ['input', 'tap', '10', '20'].join())).toBe(true)
    session.close()
  })

  it('a phone without grpc streams through mobilecli mjpeg', async () => {
    const j = jpeg(540, 1260)
    const runner = new FakeRunner(Buffer.concat([Buffer.from('Starting video stream--b\r\nContent-Type: image/jpeg\r\n\r\n'), j, Buffer.from('\r\n'), j]))
    const session = new AndroidSession(phone, new AdbClient('adb', runner), undefined, 50, new MobilecliClient('mobilecli', runner))
    expect(await awaitFrame(session)).toBe(true)
    expect(runner.commands.some((c) => c.join(' ') === `mobilecli screencapture --device ${phone.id} -f mjpeg`)).toBe(true)
    session.close()
  })

  it('a failing mobilecli stream falls back to adb screenshots', async () => {
    const runner = new FakeRunner()
    const session = new AndroidSession(phone, new AdbClient('adb', runner), undefined, 50, new MobilecliClient('mobilecli', runner))
    expect(await awaitFrame(session)).toBe(true)
    expect(session.transport).toBe('adb screenshots')
    expect(session.transportInfo().fallbackReason).toContain('mobilecli MJPEG stream unavailable')
    session.close()
  })

  it('folding the phone restarts the mobilecli stream', async () => {
    const j = jpeg(540, 1260)
    const data = Buffer.concat([Buffer.from('Starting video stream--b\r\nContent-Type: image/jpeg\r\n\r\n'), j])
    const runner = new FakeRunner(data, true)
    const session = new AndroidSession(phone, new AdbClient('adb', runner), undefined, 50, new MobilecliClient('mobilecli', runner), 50)
    const statuses: string[] = []
    expect(await awaitFrame(session, statuses)).toBe(true)
    runner.wmSize = 'Physical size: 2256x2504\n'
    expect(await waitFor(() => statuses.some((s) => s.startsWith('Display changed to 2256x2504')))).toBe(true)
    const streams = (): number => runner.commands.filter((c) => c.includes('screencapture')).length
    await waitFor(() => streams() >= 2)
    expect(streams()).toBe(2)
    session.close()
  })
})

describe('android hierarchy fallback', () => {
  const raw = fixture('mobilecli_android_raw_dump.json')
  const device = makeDevice({ id: 'emulator-5554', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR' })

  /** uiautomator is killed (exit 137) like on the Android 17 emulator; mobilecli returns the fixture for the AVD name (or fails). */
  const runner = (mobilecliWorks = true): ScriptedRunner =>
    new ScriptedRunner((command) => {
      if (command.includes('uiautomator')) return new CommandResult(137, Buffer.from('Killed'), '')
      if (command.includes('emu')) return ok('Pixel_9\r\nOK\r\n')
      // mobilecli only knows the emulator by its AVD name.
      if (command.includes('mobilecli') && command.includes('raw')) return mobilecliWorks && command.includes('Pixel_9') ? ok(raw) : new CommandResult(1, Buffer.alloc(0), 'device not found')
      return ok()
    })

  it('parses the mobilecli android raw dump', () => {
    const root = MobilecliAndroidRawParser.parse(raw)
    const cart = [...root.walk()].find((n) => n.resourceId === 'cart-button')!
    expect(cart.type).toBe('Button')
    expect(cart.label).toBe('Cart')
    expect(cart.bounds).toBeDefined()
    expect([...root.walk()].some((n) => n.text === 'Products')).toBe(true)
  })

  it('uses mobilecli first, without touching uiautomator', async () => {
    const r = runner()
    const session = new AndroidSession(device, new AdbClient('adb', r), undefined, 250, new MobilecliClient('mobilecli', r))
    expect([...(await session.hierarchy()).walk()].some((n) => n.resourceId === 'cart-button')).toBe(true)
    expect(r.commands.some((c) => c.includes('uiautomator'))).toBe(false)
  })

  it('falls back to uiautomator when mobilecli fails', async () => {
    const r = runner(false)
    const session = new AndroidSession(device, new AdbClient('adb', r), undefined, 250, new MobilecliClient('mobilecli', r))
    await expect(session.hierarchy()).rejects.toThrow(/uiautomator dump failed/)
  })

  it('without mobilecli the uiautomator failure surfaces', async () => {
    await expect(new AndroidSession(device, new AdbClient('adb', runner()), undefined).hierarchy()).rejects.toThrow()
  })
})
