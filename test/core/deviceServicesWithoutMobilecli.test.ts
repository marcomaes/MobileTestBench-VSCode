// ported-from: test:DeviceServicesWithoutMobilecliTest.kt
// Only the cases whose feature exists in the extension so far (files, screen recording, logs and input add theirs with their ports).
import { describe, expect, it } from 'vitest'
import { DeviceServices } from '../../src/deviceServices'
import { makeDevice } from '../../src/core/model'
import { IosSimulatorSession } from '../../src/core/ios/iosSimulatorSession'
import { ToolLocator } from '../../src/core/exec/toolLocator'
import { defaultSettings } from '../../src/settings'

/** A machine without mobilecli: every feature that needs it must fail with a message that says so, not an exception from deep inside. */
describe('device services without mobilecli', () => {
  const android = makeDevice({ id: 'R3GL701H6WK', name: 'Phone', platform: 'ANDROID', kind: 'PHYSICAL' })
  const iphone = makeDevice({ id: '00008110-000C28D91107801E', name: 'iPhone', platform: 'IOS', kind: 'PHYSICAL' })
  const simulator = makeDevice({ id: 'F2368465', name: 'iPhone 17 Pro', platform: 'IOS', kind: 'SIMULATOR' })
  const services = (): DeviceServices => new DeviceServices(() => ({ ...defaultSettings, wdaUrl: '', mjpegUrl: '' }), {}, undefined, new ToolLocator({}, 'darwin', '/nonexistent-home', [], () => false))

  it('testMobilecliIsNotFound', () => {
    expect(services().mobilecli()).toBeUndefined()
  })

  it('testGenericMobilecliCallSaysHowToInstall', async () => {
    const e = await services().mobilecliCall(android, ['device', 'info']).catch((x: Error) => x)
    expect((e as Error).message).toContain('mobilecli is required')
    expect((e as Error).message).toContain('npm install -g mobilecli')
  })

  it('testPhysicalIphoneNeedsMobilecli', async () => {
    await expect(services().createSession(iphone)).rejects.toThrow(/mobilecli is required for physical iOS devices/)
  })

  it('a simulator without mobilecli and without WDA gets simctl screenshots only', async () => {
    const session = await services().createSession(simulator)
    expect(session).toBeInstanceOf(IosSimulatorSession)
    expect(session.supportsInput).toBe(false)
  })
})
