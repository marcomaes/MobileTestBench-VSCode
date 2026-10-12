// ported-from: test:core/ParsersTest.kt
import { describe, expect, it } from 'vitest'
import { AdbOutput } from '../../src/core/android/adbClient'
import { AdbDevicesParser, SimctlDevicesParser } from '../../src/core/discovery/deviceParsers'
import { isUsable } from '../../src/core/model'

describe('parsers', () => {
  it('parses adb devices -l', () => {
    const output = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
      'R58M123ABC             unauthorized usb:1-1 transport_id:2',
      '',
    ].join('\n')
    const devices = AdbDevicesParser.parse(output)
    expect(devices).toHaveLength(2)
    expect(devices[0].id).toBe('emulator-5554')
    expect(devices[0].kind).toBe('EMULATOR')
    expect(devices[0].name).toBe('sdk gphone64 arm64')
    expect(isUsable(devices[0])).toBe(true)
    expect(devices[1].kind).toBe('PHYSICAL')
    expect(isUsable(devices[1])).toBe(false)
  })

  it('parses simctl booted json', () => {
    const json = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
          { udid: 'AAAA-1111', name: 'iPhone 15', state: 'Booted', isAvailable: true },
          { udid: 'BBBB-2222', name: 'iPhone SE', state: 'Shutdown', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [],
      },
    })
    const devices = SimctlDevicesParser.parse(json)
    expect(devices).toHaveLength(1)
    expect(devices[0].id).toBe('AAAA-1111')
    expect(devices[0].osVersion).toBe('iOS 17.5')
    expect(devices[0].platform).toBe('IOS')
  })

  it('wm size prefers override', () => {
    expect(AdbOutput.parseWmSize('Physical size: 1080x2400\n')).toEqual({ width: 1080, height: 2400 })
    expect(AdbOutput.parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n')).toEqual({ width: 720, height: 1600 })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const warning = Buffer.from('[Warning] Multiple displays were found, but no display id was specified.\n')
    expect([...AdbOutput.pngFrom(Buffer.concat([warning, png]))]).toEqual([...png])
    expect([...AdbOutput.pngFrom(png)]).toEqual([...png])
    expect(AdbOutput.parseWmSize('error: device offline')).toBeUndefined()
  })

  it('escapes adb input text', () => {
    expect(AdbOutput.escapeInputText('hello world')).toBe('hello%sworld')
    expect(AdbOutput.escapeInputText("a&b'c")).toBe("a\\&b\\'c")
    expect(AdbOutput.escapeInputText('user@example.com')).toBe('user@example.com')
  })
})
