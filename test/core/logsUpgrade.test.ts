// ported-from: test:core/LogsUpgradeTest.kt
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AndroidLogParser, LogEntry, LogFilter, LogLevel } from '../../src/core/logs/logs'
import { LogStream } from '../../src/core/logs/logStream'
import { MobilecliLogParser } from '../../src/core/logs/mobilecliLogParser'
import { StackFrame, StackFrames } from '../../src/core/logs/stackFrames'
import { fixture } from '../helpers/fixtures'

const e = (tag: string, msg: string, pid = '1') => new LogEntry('10-04 11:00:00.000', LogLevel.INFO, tag, pid, msg)
const fixtureLines = (name: string) => fixture(name).split(/\r?\n/).filter((l) => l.trim().length > 0)
const range = (first: number, last: number) => ({ first, last })

describe('LogsUpgradeTest', () => {
  it('regex filters match case insensitively anywhere', () => {
    const f = new LogFilter({ text: 'time(d)?out|refused', tag: '^ok.*ttp$', regex: true })
    expect(f.matches(e('OkHttp', 'Connection REFUSED by host'))).toBe(true)
    expect(f.matches(e('okhttp', 'request timeout'))).toBe(true)
    expect(f.matches(e('okhttp', 'all fine'))).toBe(false)
    expect(f.matches(e('retrofit', 'timeout'))).toBe(false)
    // without the toggle the same text is plain
    expect(new LogFilter({ text: 'time(d)?out' }).matches(e('t', 'timeout'))).toBe(false)
    expect(new LogFilter({ text: 'time(d)?out' }).matches(e('t', 'a time(d)?out here'))).toBe(true)
  })

  it('an invalid pattern is reported and ignored', () => {
    const f = new LogFilter({ text: 'abc(', regex: true })
    expect(f.textError).toBeDefined()
    expect(f.tagError).toBeUndefined()
    expect(f.matches(e('t', 'anything'))).toBe(true)
    expect(f.matchRanges('abc(')).toEqual([])
    const g = new LogFilter({ tag: '[', regex: true })
    expect(g.tagError).toBeDefined()
    expect(g.matches(e('whatever', 'x'))).toBe(true)
    expect(new LogFilter({ text: 'abc(', regex: false }).textError).toBeUndefined()
    expect(new LogFilter({ text: '  ', regex: true }).textError).toBeUndefined()
  })

  it('match ranges for plain and regex text', () => {
    expect(new LogFilter({ text: 'boom' }).matchRanges('a - boom and boom')).toEqual([range(4, 7), range(13, 16)])
    expect(new LogFilter({ text: 'ERRO' }).matchRanges('error')).toEqual([range(0, 3)])
    expect(new LogFilter({ text: '\\d+', regex: true }).matchRanges('ab123 x 45')).toEqual([range(2, 4), range(8, 9)])
    expect(new LogFilter({ text: '' }).matchRanges('abc')).toEqual([])
    expect(new LogFilter({ text: 'x*', regex: true }).matchRanges('abc')).toEqual([]) // empty matches are not painted
  })

  it('a bundle id as the app filter matches the process name on ios', () => {
    const f = new LogFilter({ app: 'com.mobilenext.playground', bundleIdLastPart: true })
    expect(f.matches(e('Playground', 'x'))).toBe(true)
    expect(f.matches(e('SpringBoard', 'x'))).toBe(false)
    // Without the iOS flag the last segment is not used (so com.example.app does not match every tag containing "app").
    expect(new LogFilter({ app: 'com.example.app' }).matches(e('Playground', 'x'))).toBe(false)
    expect(new LogFilter({ app: 'play' }).matches(e('Playground', 'x'))).toBe(true)
  })

  it('extracts java and kotlin frames', () => {
    expect(StackFrames.extract('\tat com.example.Foo.bar(Foo.java:12)')).toEqual(new StackFrame('com.example.Foo', 'bar', 'Foo.java', 12))
    expect(StackFrames.extract('    at com.example.MainKt$main$1.invokeSuspend(Main.kt:12)')).toEqual(new StackFrame('com.example.MainKt$main$1', 'invokeSuspend', 'Main.kt', 12))
    expect(StackFrames.extract('\tat android.app.LocaleConfig.<init>(LocaleConfig.java:154)')).toEqual(new StackFrame('android.app.LocaleConfig', '<init>', 'LocaleConfig.java', 154))
    expect(StackFrames.extract('at java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:644)')).toEqual(
      new StackFrame('java.util.concurrent.ThreadPoolExecutor$Worker', 'run', 'ThreadPoolExecutor.java', 644),
    )
    expect(StackFrames.extract('at a.B.lambda$foo$0(B.kt:3)')).toEqual(new StackFrame('a.B', 'lambda$foo$0', 'B.kt', 3))
    expect(StackFrames.extract('crashed (Foo.kt:34)')).toEqual(new StackFrame(undefined, undefined, 'Foo.kt', 34))
    expect(StackFrames.extract('at com.example.Foo$Inner.x(Foo.java:1)')!.packagePath).toBe('com/example')
    expect(StackFrames.extract('at Foo.x(Foo.java:1)')!.packagePath).toBe('')
  })

  it('rejects frames that have no source', () => {
    expect(StackFrames.extract('\tat android.os.BinderProxy.transactNative(Native Method)')).toBeUndefined()
    expect(StackFrames.extract('\tat tk_trace.handleBroadcast 2 ms(Unknown Source:0)')).toBeUndefined()
    expect(StackFrames.extract('\tat a.B.c(SourceFile:12)')).toBeUndefined()
    expect(StackFrames.extract('\tat cgfc.createPackageContext(:com.google.android.gms@263131035@26.31.31 (260400-959389638):3)')).toBeUndefined()
    expect(StackFrames.extract('Caused by: android.system.ErrnoException: write failed: EPIPE (Broken pipe)')).toBeUndefined()
    expect(StackFrames.extract('\t... 33 more')).toBeUndefined()
    expect(StackFrames.extract('at a.B.c(B.java:0)')).toBeUndefined()
  })

  it('real logcat trace has frames in the right entries', () => {
    const entries = fixtureLines('android-logcat-stacktrace.txt').map((l) => AndroidLogParser.parse(l)).filter((x): x is LogEntry => x !== undefined)
    const frames = entries.map((x) => StackFrames.extractFromMessage(x.message)).filter((f): f is StackFrame => f !== undefined)
    expect(frames.length).toBeGreaterThanOrEqual(5)
    expect(frames[0].file).toBe('XmlUtils.java')
    expect(frames[0].line).toBe(1580)
    expect(frames.every((f) => !f.file.includes('Unknown'))).toBe(true)
  })

  it('multi line message uses its first frame and lists all', () => {
    const msg = 'Crash\n  at com.x.A.a(A.java:1)\n  at com.x.B.b(B.kt:2)'
    expect(StackFrames.extractFromMessage(msg)!.file).toBe('A.java')
    expect(StackFrames.allFrames(msg).map((f) => f.file)).toEqual(['A.java', 'B.kt'])
    expect(StackFrames.extractFromMessage('nothing here\nat all')).toBeUndefined()
  })

  it('chooses the file by package path', () => {
    const frame = new StackFrame('com.example.ui.Foo', 'bar', 'Foo.java', 1)
    const paths = ['/p/app/src/org/other/Foo.java', '/p/app/src/com/example/ui/Foo.java', '/p/lib/src/com/example/Foo.java']
    expect(StackFrames.choose(paths, frame)).toBe('/p/app/src/com/example/ui/Foo.java')
    expect(StackFrames.choose(['/p/a/Foo.java'], frame)).toBe('/p/a/Foo.java')
    expect(StackFrames.choose(['/x/Foo.java', '/y/Foo.java'], frame)).toBe('/x/Foo.java') // none fits: the first
    expect(StackFrames.choose([], frame)).toBeUndefined()
  })

  it('parses mobilecli android lines', () => {
    const entries = fixtureLines('mobilecli_device_logs_android.txt').map((l) => MobilecliLogParser.parse(l)!)
    expect(entries).toHaveLength(10)
    const first = entries[0]
    expect(first.time).toBe('10-05 03:03:50.597')
    expect(first.tag).toBe('adbd')
    expect(first.pid).toBe('516')
    expect(first.level).toBe(LogLevel.INFO)
    expect(entries[2].level).toBe(LogLevel.ERROR)
    expect(entries[2].tag).toBe('SatelliteController')
    expect(entries.some((x) => x.level === LogLevel.VERBOSE)).toBe(true)
    expect(entries.some((x) => x.level === LogLevel.DEBUG)).toBe(true)
    expect(entries.some((x) => x.level === LogLevel.WARN)).toBe(true)
  })

  it('parses mobilecli ios lines', () => {
    const entries = fixtureLines('mobilecli_device_logs_ios.txt').map((l) => MobilecliLogParser.parse(l)!)
    expect(entries).toHaveLength(11)
    expect(entries[0].time).toBe('10-05 03:03:51.806') // microseconds and zone cut
    expect(entries[0].tag).toBe('backboardd')
    expect(entries[0].level).toBe(LogLevel.INFO) // empty level
    expect(entries[1].tag).toBe('gamecontrollerd')
    expect(entries[2].message).toContain('<_GCDriverClientConnection')
    expect(entries.some((x) => x.level === LogLevel.FATAL)).toBe(true)
    expect(entries.some((x) => x.level === LogLevel.ERROR)).toBe(true)
    expect(entries.some((x) => x.message.includes('\n'))).toBe(true)
  })

  it('mobilecli parser ignores non log lines', () => {
    expect(MobilecliLogParser.parse('not json')).toBeUndefined()
    expect(MobilecliLogParser.parse('{"status":"error","error":"device not found"}')).toBeUndefined()
    expect(MobilecliLogParser.parse('{broken')).toBeUndefined()
  })

  it.skipIf(!existsSync('/bin/sh'))('closing the stream also ends children of the process', async () => {
    let stream!: LogStream
    const ended = new Promise<void>((resolve) => {
      // the shell stays as a wrapper around a child sleep, like the mobilecli node wrapper around its native child
      stream = LogStream.start(() => spawn('sh', ['-c', 'sleep 30; echo done']), AndroidLogParser.parse.bind(AndroidLogParser), () => {}, () => resolve())
    })
    await new Promise((r) => setTimeout(r, 300))
    stream.close()
    await ended
  })
})
