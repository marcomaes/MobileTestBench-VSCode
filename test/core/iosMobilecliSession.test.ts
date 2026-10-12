// ported-from: test:core/IosMobilecliSessionTest.kt
// ported-from: test:core/AgentInstallHintTest.kt
import { describe, expect, it } from 'vitest'
import { MobilecliDeviceInfoParser, MobilecliDevicesParser } from '../../src/core/discovery/deviceParsers'
import { CommandResult } from '../../src/core/exec/commandRunner'
import { MobilecliDumpParser } from '../../src/core/inspector/hierarchyParsers'
import { HierarchyQueries } from '../../src/core/inspector/uiNode'
import { AgentInstallHint } from '../../src/core/ios/agentInstallHint'
import { IosMobilecliSession } from '../../src/core/ios/iosMobilecliSession'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { isUsable, makeDevice, rect } from '../../src/core/model'
import { UnsupportedOperationOnDevice } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'
import { fakeProcess, jpeg, png, ScriptedRunner, waitFor } from '../helpers/fakeProcess'

const device = makeDevice({ id: '00008110-001A', name: 'iPhone', platform: 'IOS', kind: 'PHYSICAL' })
const ok = (data: Buffer | string = ''): CommandResult => new CommandResult(0, Buffer.from(data), '')

function runner(stream?: Buffer): ScriptedRunner {
  return new ScriptedRunner(
    (command) => {
      if (command.includes('screenshot')) return ok(png(40, 80))
      if (command.includes('info')) return ok('{"status":"ok","data":{"device":{"screenSize":{"width":402,"height":874,"scale":3}}}}')
      if (command.includes('dump')) return ok(fixture('mobilecli_ios_dump.json'))
      return ok()
    },
    () => {
      if (!stream) throw new Error('no stream')
      return fakeProcess(stream)
    },
  )
}

const session = (r: ScriptedRunner): IosMobilecliSession => new IosMobilecliSession(device, new MobilecliClient('mobilecli', r), 50)

async function awaitFrame(s: IosMobilecliSession): Promise<boolean> {
  let got = false
  s.start({ onFrame: () => { got = true }, onError: () => {} })
  return waitFor(() => got)
}

describe('ios mobilecli session', () => {
  it('uses the mobilecli mjpeg stream when it works', async () => {
    const j = jpeg(40, 80)
    const r = runner(Buffer.concat([Buffer.from('Starting video stream--b\r\nContent-Type: image/jpeg\r\n\r\n'), j, Buffer.from('\r\n'), j]))
    const s = session(r)
    expect(await awaitFrame(s)).toBe(true)
    expect(r.commands.some((c) => c.join(' ') === `mobilecli screencapture --device ${device.id} -f mjpeg`)).toBe(true)
    s.close()
  })

  it('falls back to screenshots when the stream cannot start', async () => {
    const r = runner()
    const s = session(r)
    expect(await awaitFrame(s)).toBe(true)
    expect(s.transport).toBe('mobilecli screenshots')
    expect(r.commands.some((c) => c.includes('screenshot') && c.slice(-2).join() === ['-o', '-'].join())).toBe(true)
    s.close()
  })

  it('forwards input and reads screen size and hierarchy through mobilecli', async () => {
    const r = runner()
    const s = session(r)
    await s.tap(10, 20)
    await s.swipe(1, 2, 3, 4, 250)
    await s.press('HOME')
    await s.press('DELETE')
    await s.typeText('-hi')
    const root = await s.hierarchy()
    await s.refreshSize()
    expect(s.logicalSize()).toEqual({ width: 402, height: 874 })
    expect([...root.walk()].some((n) => n.label === 'Fitness')).toBe(true)
    const has = (...args: string[]): boolean => r.commands.some((c) => c.join('\u0000') === args.join('\u0000'))
    expect(has('mobilecli', 'io', 'tap', '--device', device.id, '10,20')).toBe(true)
    expect(has('mobilecli', 'io', 'swipe', '--device', device.id, '--duration', '250', '1,2,3,4')).toBe(true)
    expect(has('mobilecli', 'io', 'button', '--device', device.id, 'HOME')).toBe(true)
    expect(has('mobilecli', 'io', 'keys', '--device', device.id, 'backspace')).toBe(true)
    expect(has('mobilecli', 'io', 'text', '--device', device.id, '--', '-hi')).toBe(true)
    await expect(s.press('BACK')).rejects.toBeInstanceOf(UnsupportedOperationOnDevice)
    s.close()
  })

  it('parses physical ios devices and skips simulators and android', () => {
    const json = JSON.stringify({
      status: 'ok',
      data: {
        devices: [
          { id: 'Pixel_9', name: 'Pixel 9', platform: 'android', type: 'emulator', version: '17', state: 'online' },
          { id: 'SIM-1', name: 'iPhone 17 Pro', platform: 'ios', type: 'simulator', version: '26.5', state: 'online' },
          { id: '00008110-001A', name: "Marco's iPhone", platform: 'ios', type: 'real', version: '18.2', state: 'online' },
        ],
      },
    })
    const devices = MobilecliDevicesParser.parse(json)
    expect(devices).toHaveLength(1)
    expect(devices[0].id).toBe('00008110-001A')
    expect(devices[0].kind).toBe('PHYSICAL')
    expect(devices[0].platform).toBe('IOS')
    expect(devices[0].osVersion).toBe('iOS 18.2')
    expect(isUsable(devices[0])).toBe(true)
  })

  it('parses device info and the ui dump fixture', () => {
    const info = '{"status":"ok","data":{"device":{"id":"x","screenSize":{"width":402,"height":874,"scale":3}}}}'
    expect(MobilecliDeviceInfoParser.parseScreenSize(info)).toEqual({ width: 402, height: 874 })
    const root = MobilecliDumpParser.parse(fixture('mobilecli_ios_dump.json'))
    expect(root.rawType).toBe('XCUIElementTypeApplication')
    const fitness = [...root.walk()].find((n) => n.label === 'Fitness')!
    expect(fitness.type).toBe('Icon')
    expect(fitness.rawType).toBe('XCUIElementTypeIcon')
    expect(fitness.bounds).toEqual(rect(28, 88, 68, 90))
    expect(HierarchyQueries.deepestAt(root, 40, 100)).toBeDefined()
  })
})

describe('agent install hint', () => {
  const raw =
    'Screenshot failed: Exit code 1: /bin/mobilecli screenshot --device 0000-1 -o - failed to start agent on device 0000-1: ' +
    "agent is not installed, use 'mobilecli agent install --device 0000-1 --provisioning-profile  ' to install it"

  it('missingAgentBecomesFullSetupHint', () => {
    const hint = AgentInstallHint.rewrite(raw, '0000-1')
    expect(hint).toContain('mobilecli agent install --device 0000-1 --provisioning-profile <file.mobileprovision>')
    expect(hint).toContain('Developer Mode')
    expect(hint).toContain('UDID')
    expect(hint).toContain('VPN & Device Management')
  })

  it('otherErrorsPassThrough', () => {
    expect(AgentInstallHint.rewrite('Screenshot failed: boom', '0000-1')).toBe('Screenshot failed: boom')
  })
})
