// ported-from: test:core/LogsTest.kt
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AndroidLogParser, IosLogParser, LogEntry, LogFilter, LogLevel } from '../../src/core/logs/logs'
import { LogStream } from '../../src/core/logs/logStream'

const hasSh = existsSync('/bin/sh')
const entry = (level: LogLevel, tag: string, pid: string, message: string) => new LogEntry('t', level, tag, pid, message)

describe('LogsTest', () => {
  it('parses logcat threadtime lines', () => {
    const e = AndroidLogParser.parse('10-04 11:03:54.580   647   810 E WifiDataStall: Ignore this poll. newStats: null rssi: -50')!
    expect(e.time).toBe('10-04 11:03:54.580')
    expect(e.level).toBe(LogLevel.ERROR)
    expect(e.tag).toBe('WifiDataStall')
    expect(e.pid).toBe('647')
    expect(e.message).toBe('Ignore this poll. newStats: null rssi: -50')
    expect(AndroidLogParser.parse('10-04 11:03:54.483  2683  2686 I artd    : GetBestInfo: /data/x has no usable artifacts')!.level).toBe(LogLevel.INFO)
    expect(AndroidLogParser.parse('10-04 11:03:54.483  2683  2686 I artd    : hello')!.tag).toBe('artd')
    expect(AndroidLogParser.parse('10-04 11:03:54.483  1  2 W Tag: x')!.level).toBe(LogLevel.WARN)
    expect(AndroidLogParser.parse('10-04 11:03:54.483  1  2 V Tag: x')!.level).toBe(LogLevel.VERBOSE)
    expect(AndroidLogParser.parse('--------- beginning of main')).toBeUndefined()
    expect(AndroidLogParser.parse('    at com.example.Foo.bar(Foo.java:12)')).toBeUndefined()
  })

  it('parses simulator log stream lines', () => {
    const e = IosLogParser.parse('2026-10-04 11:04:04.159 A  backboardd[4172:1e0008] (GamepadHIDServiceFilter) Resume Connection')!
    expect(e.time).toBe('10-04 11:04:04.159')
    expect(e.tag).toBe('backboardd')
    expect(e.pid).toBe('4172')
    expect(e.message).toBe('(GamepadHIDServiceFilter) Resume Connection')
    expect(IosLogParser.parse('2026-10-04 11:04:04.161 Db backboardd[4172:1e0008] [com.apple.xpc] x')!.level).toBe(LogLevel.DEBUG)
    expect(IosLogParser.parse('2026-10-04 11:04:04.161 Df backboardd[4172:1e0008] x')!.level).toBe(LogLevel.INFO)
    expect(IosLogParser.parse('2026-10-04 11:04:04.161 E  MyApp[1:2] boom')!.level).toBe(LogLevel.ERROR)
    expect(IosLogParser.parse('2026-10-04 11:04:04.161 F  MyApp[1:2] boom')!.level).toBe(LogLevel.FATAL)
    expect(IosLogParser.parse('Timestamp               Ty Process[PID:TID]')).toBeUndefined()
    expect(IosLogParser.parse(')}')).toBeUndefined()
  })

  it('the filter combines level, text, tag and app', () => {
    const e = entry(LogLevel.WARN, 'OkHttp', '42', 'Request failed: timeout')
    expect(new LogFilter({ minLevel: LogLevel.WARN }).matches(e)).toBe(true)
    expect(new LogFilter({ minLevel: LogLevel.ERROR }).matches(e)).toBe(false)
    expect(new LogFilter({ text: 'TIMEOUT' }).matches(e)).toBe(true)
    expect(new LogFilter({ text: 'nope' }).matches(e)).toBe(false)
    expect(new LogFilter({ tag: 'okhttp' }).matches(e)).toBe(true)
    expect(new LogFilter({ tag: 'retrofit' }).matches(e)).toBe(false)
    expect(new LogFilter({ minLevel: LogLevel.VERBOSE }).matches(entry(LogLevel.VERBOSE, 't', '1', 'm'))).toBe(true)
    expect(new LogFilter().matches(entry(LogLevel.DEBUG, 't', '1', 'm'))).toBe(false) // Info is the default
  })

  it('an app is matched by its process ids on android and by name on ios', () => {
    const mine = entry(LogLevel.INFO, 'OkHttp', '42', 'x')
    const other = entry(LogLevel.INFO, 'OkHttp', '99', 'x')
    const android = new LogFilter({ app: 'com.example.app', appPids: new Set(['42']) })
    expect(android.matches(mine)).toBe(true)
    expect(android.matches(other)).toBe(false)
    expect(new LogFilter({ app: 'com.example.app', appPids: new Set() }).matches(mine)).toBe(false) // not running: nothing to show
    const ios = new LogFilter({ app: 'myapp' })
    expect(ios.matches(entry(LogLevel.INFO, 'MyApp', '1', 'x'))).toBe(true)
    expect(ios.matches(entry(LogLevel.INFO, 'SpringBoard', '1', 'x'))).toBe(false)
  })

  it.skipIf(!hasSh)('continuation lines join the entry before them', async () => {
    const entries: LogEntry[] = []
    const script = "printf '10-04 11:00:00.001  1  2 E App: Crash\\n    at Foo.bar(Foo.java:1)\\n    at Foo.baz(Foo.java:2)\\n10-04 11:00:00.002  1  2 I App: next\\n'"
    await new Promise<void>((resolve) => {
      LogStream.start(() => spawn('sh', ['-c', script]), AndroidLogParser.parse.bind(AndroidLogParser), (e) => entries.push(e), () => resolve())
    })
    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('Crash\n    at Foo.bar(Foo.java:1)\n    at Foo.baz(Foo.java:2)')
    expect(entries[1].message).toBe('next')
  })

  it.skipIf(!hasSh)('a stream that fails reports what the process said', async () => {
    const message = await new Promise<string | undefined>((resolve) => {
      LogStream.start(() => spawn('sh', ['-c', "echo 'device offline' >&2; exit 1"]), AndroidLogParser.parse.bind(AndroidLogParser), () => {}, resolve)
    })
    expect(message).toBe('device offline')
  })

  it.skipIf(!hasSh)('closing the stream ends a running process', async () => {
    let stream!: LogStream
    const ended = new Promise<void>((resolve) => {
      stream = LogStream.start(() => spawn('sh', ['-c', 'exec sleep 30']), AndroidLogParser.parse.bind(AndroidLogParser), () => {}, () => resolve())
    })
    stream.close()
    await ended
  })
})
