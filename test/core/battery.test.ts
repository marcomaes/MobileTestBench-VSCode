// ported-from: test:core/BatteryTest.kt
import { describe, expect, it } from 'vitest'
import { BatteryChange, BatteryCommands, BatteryParsers } from '../../src/core/battery/battery'

const dump = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Max charging current: 500000
  status: 2
  health: 2
  present: true
  level: 42
  scale: 100
  voltage: 5000
  temperature: 250
  technology: Li-ion`

describe('BatteryTest', () => {
  it('parsesState', () => {
    const s = BatteryParsers.state(dump)!
    expect(s.level).toBe(42)
    expect(s.status).toBe('CHARGING')
    expect(s.ac).toBe(false)
    expect(s.usb).toBe(true)
    expect(s.updatesStopped).toBe(false)
  })

  it('detectsUpdatesStopped', () => {
    expect(BatteryParsers.state('Current Battery Service state:\n  UPDATES STOPPED\n  status: 3\n  level: 5')!.updatesStopped).toBe(true)
  })

  it('garbageIsNull', () => {
    expect(BatteryParsers.state('nothing here')).toBeUndefined()
  })

  it('buildsCommands', () => {
    const set = (c: BatteryChange) => BatteryCommands.set('adb', 'emulator-5554', c).slice(3)
    expect(set(BatteryChange.Level(15))).toEqual(['shell', 'dumpsys', 'battery', 'set', 'level', '15'])
    expect(set(BatteryChange.Status('FULL'))).toEqual(['shell', 'dumpsys', 'battery', 'set', 'status', '5'])
    expect(set(BatteryChange.Ac(false))).toEqual(['shell', 'dumpsys', 'battery', 'set', 'ac', '0'])
    expect(set(BatteryChange.Usb(true))).toEqual(['shell', 'dumpsys', 'battery', 'set', 'usb', '1'])
    expect(BatteryCommands.reset('adb', 'x').at(-1)).toBe('reset')
  })

  it('validatesLevel', () => {
    expect(BatteryCommands.validLevel(0) && BatteryCommands.validLevel(100)).toBe(true)
    expect(BatteryCommands.validLevel(101) || BatteryCommands.validLevel(-1)).toBe(false)
  })

  it('findsErrors', () => {
    expect(BatteryParsers.error('Unknown set option: foo')).toBeDefined()
    expect(BatteryParsers.error('')).toBeUndefined()
    expect(BatteryParsers.errorLine('', 'boom\nmore', 1)).toBe('boom')
  })
})
