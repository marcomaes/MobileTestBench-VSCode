// ported-from: test:core/CrashesTest.kt
import { describe, expect, it } from 'vitest'
import { crashEntry, Crashes } from '../../src/core/crashes/crashes'
import { fixture as read } from '../helpers/fixtures'

const fixture = (name: string): unknown => JSON.parse(read(name)).data
const desc = (xs: string[]) => [...xs].sort().reverse()

describe('CrashesTest', () => {
  it('android list is sorted newest first', () => {
    const list = Crashes.parseList(fixture('crash_list_android.json'))
    expect(list.length).toBeGreaterThanOrEqual(3)
    expect(list.map((e) => e.timestamp)).toEqual(desc(list.map((e) => e.timestamp)))
  })

  it('ios list is sorted by time and keeps ids with spaces', () => {
    const list = Crashes.parseList(fixture('crash_list_ios.json'))
    expect(list.map((e) => e.timestamp)).toEqual(desc(list.map((e) => e.timestamp)))
    expect(list.some((e) => e.id.includes(' '))).toBe(true)
  })

  it('null or malformed data is an empty list', () => {
    expect(Crashes.parseList(undefined)).toEqual([])
    expect(Crashes.parseList({})).toEqual([])
    expect(Crashes.parseList([])).toEqual([])
  })

  it('filter matches process id and time', () => {
    const l = [crashEntry('a_1', 'com.Foo', '2026-01-01 10:00:00'), crashEntry('b_2', 'bar', '2026-02-02 10:00:00')]
    expect(Crashes.filter(l, 'FOO')).toHaveLength(1)
    expect(Crashes.filter(l, 'b_2')).toHaveLength(1)
    expect(Crashes.filter(l, '2026-02')).toHaveLength(1)
    expect(Crashes.filter(l, ' ')).toHaveLength(2)
  })

  it('java crash summary is the exception line', () => {
    const content = Crashes.parseReport(fixture('crash_get_android_java.json'))!
    expect(Crashes.summary('ANDROID', content)!.startsWith('java.lang.IllegalStateException: UiAutomationService')).toBe(true)
  })

  it('tombstone summary is the signal', () => {
    const content = Crashes.parseReport(fixture('crash_get_android_tombstone.json'))!
    expect(Crashes.summary('ANDROID', content)).toBe('SIGSEGV (SEGV_MAPERR) fault addr 0x0000000000005150')
  })

  it('ios summary has exception and termination', () => {
    const content = Crashes.parseReport(fixture('crash_get_ios_ips.json'))!
    const s = Crashes.summary('IOS', content)!
    expect(s.startsWith('EXC_CRASH (SIGABRT) - Abort trap: 6'), s).toBe(true)
  })

  it('summary is null when nothing is recognised', () => {
    expect(Crashes.summary('ANDROID', 'nothing here')).toBeUndefined()
    expect(Crashes.summary('IOS', 'not json\nstill not')).toBeUndefined()
  })

  it('file names are safe', () => {
    expect(Crashes.fileName(crashEntry('2026-09-14_15:48:07.216_26798', 'x', ''), 'ANDROID')).toBe('2026-09-14_15-48-07.216_26798.txt')
    expect(Crashes.fileName(crashEntry('ExcUserFault_Google Chrome-1.ips', 'x', ''), 'IOS')).toBe('ExcUserFault_Google Chrome-1.ips')
  })

  it('get args keep the id as one argument', () => {
    expect(Crashes.getArgs('a b:c')).toEqual(['device', 'crashes', 'get', 'a b:c'])
  })
})
