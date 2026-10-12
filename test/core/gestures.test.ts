// ported-from: test:core/GesturesTest.kt
import { describe, expect, it } from 'vitest'
import { AdbClient } from '../../src/core/android/adbClient'
import { AndroidSession } from '../../src/core/android/androidSession'
import type { EmulatorLink } from '../../src/core/android/emulatorLink'
import { Gestures } from '../../src/core/input/gestures'
import { IosMobilecliSession } from '../../src/core/ios/iosMobilecliSession'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { makeDevice } from '../../src/core/model'
import { UnsupportedOperationOnDevice } from '../../src/core/session/deviceSession'
import { RecordingRunner } from '../helpers/fakeRunner'

class LinkStub implements EmulatorLink {
  calls: string[] = []
  startStreaming() {}
  async tap() { this.calls.push('tap') }
  async swipe() { this.calls.push('swipe') }
  async longPress(x: number, y: number, d: number) { this.calls.push(`longPress ${x},${y},${d}`) }
  async doubleTap(x: number, y: number) { this.calls.push(`doubleTap ${x},${y}`) }
  async dragWithHold(fx: number, fy: number, tx: number, ty: number, h: number, d: number) { this.calls.push(`drag ${fx},${fy},${tx},${ty},${h},${d}`) }
  async press() {}
  async typeText() {}
  close() {}
}

const android = makeDevice({ id: 'emulator-5554', name: 'Pixel', platform: 'ANDROID', kind: 'EMULATOR' })

describe('mouse rules', () => {
  it('a release after a long press does nothing', () => {
    expect(Gestures.onRelease(true, false, false, 1)).toBe('CONSUMED')
    expect(Gestures.onRelease(true, true, true, 2)).toBe('CONSUMED')
  })

  it('click counts and movement pick the gesture', () => {
    expect(Gestures.onRelease(false, false, false, 1)).toBe('TAP')
    expect(Gestures.onRelease(false, false, false, 2)).toBe('DOUBLE_TAP')
    expect(Gestures.onRelease(false, false, false, 3)).toBe('TAP')
    expect(Gestures.onRelease(false, true, false, 2)).toBe('SWIPE')
    expect(Gestures.onRelease(false, true, true, 1)).toBe('HOLD_DRAG')
    expect(Gestures.onRelease(false, false, true, 1)).toBe('TAP')
  })

  it('slop is a distance', () => {
    expect(Gestures.movedBeyondSlop(3, 4, 6)).toBe(false)
    expect(Gestures.movedBeyondSlop(6, 8, 10)).toBe(true)
  })

  it('long press setting is clamped', () => {
    expect(Gestures.longPressMs(700)).toBe(700)
    expect(Gestures.longPressMs(0)).toBe(300)
    expect(Gestures.longPressMs(-5)).toBe(300)
    expect(Gestures.longPressMs(99999)).toBe(3000)
    expect(Gestures.longPressMs(450)).toBe(450)
  })
})

describe('sessions', () => {
  it('android over gRPC does all three gestures through the link', async () => {
    const link = new LinkStub()
    const session = new AndroidSession(android, new AdbClient('adb', new RecordingRunner()), link)
    expect(session.supportsDoubleTap && session.supportsHoldDrag).toBe(true)
    await session.longPress(1, 2, 700)
    await session.doubleTap(3, 4)
    await session.dragWithHold(1, 2, 3, 4, 700, 300)
    expect(link.calls).toEqual(['longPress 1,2,700', 'doubleTap 3,4', 'drag 1,2,3,4,700,300'])
  })

  it('android over adb long presses with a stationary swipe and refuses the rest', async () => {
    const runner = new RecordingRunner()
    const session = new AndroidSession(android, new AdbClient('adb', runner), undefined)
    await session.longPress(540, 1000, 700)
    expect(runner.commands[0].slice(-7)).toEqual(['input', 'swipe', '540', '1000', '540', '1000', '700'])
    expect(session.supportsDoubleTap || session.supportsHoldDrag).toBe(false)
    await expect(session.doubleTap(1, 2)).rejects.toThrow(/gRPC/)
    await expect(session.dragWithHold(1, 2, 3, 4)).rejects.toThrow(/gRPC/)
    await expect(session.doubleTap(1, 2)).rejects.toBeInstanceOf(UnsupportedOperationOnDevice)
  })

  it('ios via mobilecli long presses with io longpress and has no double tap', async () => {
    const runner = new RecordingRunner()
    const device = makeDevice({ id: 'F2368465', name: 'iPhone', platform: 'IOS', kind: 'SIMULATOR' })
    const session = new IosMobilecliSession(device, new MobilecliClient('mobilecli', runner))
    await session.longPress(200, 500, 700)
    expect(runner.commands[0]).toEqual(['mobilecli', 'io', 'longpress', '--device', 'F2368465', '--duration', '700', '200,500'])
    expect(session.supportsDoubleTap).toBe(false)
    expect(session.supportsHoldDrag).toBe(false)
    await expect(session.doubleTap(1, 2)).rejects.toBeInstanceOf(UnsupportedOperationOnDevice)
  })
})
