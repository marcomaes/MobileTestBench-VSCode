// ported-from: test:core/ProjectLayoutTest.kt
import { describe, expect, it } from 'vitest'
import { Apps, ForegroundApp, IOS_HOME } from '../../src/core/apps/apps'
import { makeDevice } from '../../src/core/model'
import { ForegroundText, LastDevice, ProjectLayout } from '../../src/core/project/projectLayout'

const pixel = makeDevice({ id: 'emulator-5554', name: 'Pixel_9', platform: 'ANDROID', kind: 'EMULATOR', state: 'device' })
const iphone = makeDevice({ id: 'F236', name: 'iPhone 17 Pro', platform: 'IOS', kind: 'SIMULATOR', state: 'Booted' })

describe('ProjectLayoutTest', () => {
  it('normalizedFixesBadProportions', () => {
    const l = new ProjectLayout({ mirrorProportion: NaN, toolsProportion: 1.5, toolsTab: ' Log ' }).normalized()
    expect(l.mirrorProportion).toBe(ProjectLayout.DEFAULT_MIRROR)
    expect(l.toolsProportion).toBe(ProjectLayout.DEFAULT_TOOLS)
    expect(l.toolsTab).toBe('Log')
  })

  it('keepsGoodProportions', () => {
    expect(new ProjectLayout({ mirrorProportion: 0.3 }).normalized().mirrorProportion).toBe(0.3)
  })

  it('mergeOnlyChangesSetFields', () => {
    const base = new ProjectLayout({ lastDeviceId: 'a', inspectorOpen: true, toolsTab: 'Apps' })
    const m = base.merge({ toolsOpen: true, toolsProportion: 0.4 })
    expect(m.lastDeviceId).toBe('a')
    expect(m.inspectorOpen).toBe(true)
    expect(m.toolsOpen).toBe(true)
    expect(m.toolsTab).toBe('Apps')
    expect(m.toolsProportion).toBe(0.4)
  })

  it('withDevice', () => {
    const l = new ProjectLayout().withDevice(pixel)
    expect(l.lastDeviceId).toBe('emulator-5554')
    expect(l.lastDeviceName).toBe('Pixel_9')
  })

  it('tabIn', () => {
    expect(new ProjectLayout({ toolsTab: 'Apps' }).tabIn(['Log', 'Apps'])).toBe('Apps')
    expect(new ProjectLayout({ toolsTab: 'Gone' }).tabIn(['Log'])).toBeUndefined()
    expect(new ProjectLayout().tabIn(['Log'])).toBeUndefined()
  })

  it('lastDeviceByIdThenName', () => {
    const devices = [pixel, iphone]
    expect(LastDevice.find(devices, 'F236', '')).toBe(iphone)
    // the emulator serial changed after a restart: same name
    expect(LastDevice.find(devices, 'emulator-5556', 'Pixel_9')).toBe(pixel)
    expect(LastDevice.find(devices, 'x', 'Nexus')).toBeUndefined()
    expect(LastDevice.find(devices, '', '')).toBeUndefined()
  })

  it('foregroundLabel', () => {
    expect(ForegroundText.label(new ForegroundApp('com.maps', 'Maps'))).toBe('Maps (com.maps)')
    expect(ForegroundText.label(new ForegroundApp('com.x', 'com.x'))).toBe('com.x')
    expect(ForegroundText.label(new ForegroundApp(IOS_HOME, 'SpringBoard'))).toBe('Home screen')
    expect(ForegroundText.label(undefined)).toBe(ForegroundText.UNKNOWN)
    expect(ForegroundText.copyText(new ForegroundApp('com.maps', 'Maps'))).toBe('com.maps')
    expect(ForegroundText.copyText(undefined)).toBeUndefined()
  })

  it('foregroundFromMobilecliData', () => {
    const data = JSON.parse('{"packageName":"com.mobilenext.playground","appName":"Playground","activity":".Main"}')
    const app = Apps.parseForeground(data)
    expect(ForegroundText.label(app)).toBe('Playground (com.mobilenext.playground)')
    expect(ForegroundText.label(Apps.parseForeground(JSON.parse('{}')))).toBe(ForegroundText.UNKNOWN)
  })

  it('fromJSON ignores values of the wrong type and round-trips', () => {
    const l = new ProjectLayout({ lastDeviceId: 'a', inspectorOpen: true, mirrorProportion: 0.4 })
    expect(ProjectLayout.fromJSON(l.toJSON()).equals(l)).toBe(true)
    const bad = ProjectLayout.fromJSON({ lastDeviceId: 5, inspectorOpen: 'yes', mirrorProportion: 7 })
    expect(bad.equals(new ProjectLayout())).toBe(true)
    expect(ProjectLayout.fromJSON(undefined).equals(new ProjectLayout())).toBe(true)
  })
})
