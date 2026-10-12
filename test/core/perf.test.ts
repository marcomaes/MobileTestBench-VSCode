// ported-from: test:core/PerfTest.kt
import { describe, expect, it } from 'vitest'
import { CommandResult } from '../../src/core/exec/commandRunner'
import { AndroidPerf, IosPerf, PerfException } from '../../src/core/perf/perfBackends'
import {
  CpuTracker,
  FrameDelta,
  PerfCsv,
  PerfSampler,
  RingSeries,
  StartHistory,
  StartKind,
  StartRunner,
  StartSummary,
  Stats,
  perfPoint,
  reading,
  startResult,
  startRun,
  type StartBackend,
  type StartResult,
} from '../../src/core/perf/perfModel'
import { AndroidPerfParsers, IosPerfParsers } from '../../src/core/perf/perfParsers'
import { fixture } from '../helpers/fixtures'
import { RecordingRunner } from '../helpers/fakeRunner'

const ok = (text: string, code = 0): CommandResult => new CommandResult(code, Buffer.from(text), '')
const noSleep = async (): Promise<void> => {}

describe('PerfTest', () => {
  // ---- Android parsers

  it('parsesProcStatLine', () => {
    // utime 9713 + stime 5912, counted after the last ')'
    expect(AndroidPerfParsers.statTicks(fixture('android-proc-stat-playground.txt').trim())).toBe(15625)
    // a command name with spaces and parentheses
    expect(AndroidPerfParsers.statTicks('12 (my (weird) app) S 1 1 0 0 -1 0 0 0 0 0 10 20 0 0 0')).toBe(30)
  })

  it('parsesTheProbeOutput', () => {
    const out = '1791120996.737075986\nPID=8642\n' + fixture('android-proc-stat-playground.txt') + fixture('android-proc-status-playground.txt') + 'Total frames rendered: 65\nJanky frames: 65 (100.00%)\n'
    const p = AndroidPerfParsers.parseProbe(out)
    expect(p.deviceSeconds).toBeCloseTo(1791120996.737075986, 2)
    expect(p.pid).toBe(8642)
    expect(p.cpuTicks).toBe(15625)
    expect(p.rssKb).toBe(240640)
    expect(p.swapKb).toBe(50512)
    expect(p.totalFrames).toBe(65)
    expect(p.jankyFrames).toBe(65)
  })

  it('probeOfAppThatIsNotRunning', () => {
    const p = AndroidPerfParsers.parseProbe('1791120996.5\n')
    expect(p.pid).toBeUndefined()
    expect(p.cpuTicks).toBeUndefined()
    expect(p.totalFrames).toBeUndefined()
  })

  it('parsesPssFromMeminfo', () => {
    expect(AndroidPerfParsers.parsePssKb(fixture('android-dumpsys-meminfo-playground.txt'))).toBe(120629)
    expect(AndroidPerfParsers.parsePssKb(fixture('android-dumpsys-meminfo-no-process.txt'))).toBeUndefined()
    expect(AndroidPerfParsers.parsePssKb('Got IoException! java.io.IOException: Timeout')).toBeUndefined()
    expect(AndroidPerfParsers.parsePssKb('        TOTAL   120629    38704    17616    37279   240304    53587    37895    11558\n')).toBe(120629)
  })

  it('parsesGfxinfoCounters', () => {
    expect(AndroidPerfParsers.parseGfxinfo(fixture('android-dumpsys-gfxinfo-playground.txt'))).toEqual([40, 40])
    expect(AndroidPerfParsers.parseGfxinfo(fixture('android-dumpsys-gfxinfo-no-process.txt'))).toBeUndefined()
  })

  it('parsesPidofAndActivity', () => {
    expect(AndroidPerfParsers.firstPid('8642\n')).toBe(8642)
    expect(AndroidPerfParsers.firstPid('8642 8700\n')).toBe(8642)
    expect(AndroidPerfParsers.firstPid('')).toBeUndefined()
    expect(AndroidPerfParsers.parseResolvedActivity('priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.mobilenext.playground/.MainActivity\n')).toBe(
      'com.mobilenext.playground/.MainActivity',
    )
  })

  it('parsesAmStartOutput', () => {
    const cold = AndroidPerfParsers.parseAmStart(fixture('android-am-start-W-cold.txt'))
    expect(cold.launchState).toBe('COLD')
    expect(cold.totalMs).toBe(34211)
    expect(cold.waitMs).toBe(34223)
    expect(cold.error).toBeUndefined()
    const warm = AndroidPerfParsers.parseAmStart(fixture('android-am-start-W-warm-launcher-intent.txt'))
    expect(warm.launchState).toBe('WARM')
    expect(warm.totalMs).toBe(7879)
    const plain = AndroidPerfParsers.parseAmStart(fixture('android-am-start-W-warm.txt'))
    expect(plain.totalMs).toBeUndefined()
    expect(plain.waitMs).toBe(2526)
    expect(plain.warning).toContain('brought to the front')
    const hot = AndroidPerfParsers.parseAmStart(fixture('android-am-start-W-hot.txt'))
    expect(hot.totalMs).toBe(0)
    expect(AndroidPerfParsers.parseAmStart('Error type 3\nError: Activity class {x/.Y} does not exist.\n').error).toBe('Activity class {x/.Y} does not exist.')
  })

  it('onlySafeIdsGoIntoTheScript', () => {
    expect(AndroidPerfParsers.isSafeId('com.mobilenext.playground')).toBe(true)
    expect(AndroidPerfParsers.isSafeId('a; rm -rf /')).toBe(false)
    expect(AndroidPerfParsers.isSafeId('')).toBe(false)
  })

  // ---- iOS parsers

  it('parsesLaunchctlPid', () => {
    const out = fixture('ios-simctl-launchctl-playground.txt')
    expect(IosPerfParsers.launchctlPid(out, 'com.mobilenext.playground')).toBe(35979)
    expect(IosPerfParsers.launchctlPid(out, 'com.mobilenext')).toBeUndefined()
    expect(IosPerfParsers.launchctlPid(out, 'com.not.installed')).toBeUndefined()
  })

  it('parsesFootprintAndPs', () => {
    expect(IosPerfParsers.footprintMb(fixture('ios-footprint-playground.txt'))).toBeCloseTo(28887248 / 1048576.0, 9)
    expect(IosPerfParsers.footprintMb(fixture('ios-footprint-no-process.txt'))).toBeUndefined()
    expect(IosPerfParsers.psCpuSeconds(fixture('ios-ps-time-playground.txt'))).toBeCloseTo(1.8, 9)
    expect(IosPerfParsers.psCpuSeconds('')).toBeUndefined()
    expect(IosPerfParsers.parseCpuTime('1:02:03.50')).toBeCloseTo(3723.5, 9)
    expect(IosPerfParsers.parseCpuTime('1-00:01:01')).toBeCloseTo(86400.0 + 61.0, 9)
    expect(IosPerfParsers.parseCpuTime('abc')).toBeUndefined()
  })

  it('parsesLaunchTimingFromTheSimulatorLog', () => {
    const log = fixture('ios-log-show-launch-cold.txt')
    // request 15:46:51.746, last "-> 0;" of pid 36136 at 15:46:52.807
    expect(IosPerfParsers.launchMillis(log, 'com.mobilenext.playground', 36136)).toBe(1061)
    expect(IosPerfParsers.launchMillis(log, 'com.mobilenext.playground', undefined)).toBe(1061)
    expect(IosPerfParsers.launchMillis(log, 'com.mobilenext.playground', 1)).toBeUndefined()
    expect(IosPerfParsers.launchMillis('', 'com.mobilenext.playground', 36136)).toBeUndefined()
    // a bundle id that is a prefix of the one in the log must not match its request line
    expect(IosPerfParsers.launchMillis(log, 'com.mobilenext.play', 36136)).toBeUndefined()
    expect(IosPerfParsers.launchOutputPid('com.mobilenext.playground: 36136\n')).toBe(36136)
    expect(IosPerfParsers.logStartArgument(new Date(2026, 9, 4, 15, 42, 36, 999))).toBe('2026-10-04 15:42:36')
  })

  // ---- model

  it('cpuPercentFromTimeDeltas', () => {
    const t = new CpuTracker()
    expect(t.update(10, 1.0, 100.0)).toBeUndefined() // baseline
    expect(t.update(10, 1.12, 101.0)).toBeCloseTo(12.0, 9)
    expect(t.update(10, 2.62, 102.0)).toBeCloseTo(150.0, 9) // several cores
    expect(t.update(11, 0.5, 103.0)).toBeUndefined() // a new pid re-baselines
    expect(t.update(11, 0.55, 104.0)).toBeCloseTo(5.0, 9)
    expect(t.update(undefined, undefined, 105.0)).toBeUndefined()
    expect(t.update(11, 0.6, 106.0)).toBeUndefined() // after a gap
  })

  it('frameDeltas', () => {
    const f = new FrameDelta()
    expect(f.update(1, 100, 10, 0.0)).toBeUndefined()
    const a = f.update(1, 160, 16, 1.0)!
    expect(a.fps).toBeCloseTo(60.0, 9)
    expect(a.jankPercent).toBeCloseTo(10.0, 9)
    const idle = f.update(1, 160, 16, 2.0)!
    expect(idle.fps).toBeCloseTo(0.0, 9)
    expect(idle.jankPercent).toBeUndefined()
    expect(f.update(1, 5, 1, 3.0)).toBeUndefined() // counters went down: restart or reset
    expect(f.update(1, 15, 1, 4.0)).toBeDefined()
  })

  it('samplerBuildsPointsAndGaps', () => {
    const s = new PerfSampler()
    const p1 = s.point(reading(5, 10.0, { rssMb: 200.0, cpuSeconds: 1.0, totalFrames: 10, jankyFrames: 1 }), undefined, 0.0)
    expect(p1.cpuPercent).toBeUndefined()
    expect(p1.memoryMb).toBeUndefined()
    expect(p1.rssMb).toBeCloseTo(200.0, 9)
    const p2 = s.point(reading(5, 11.0, { rssMb: 201.0, cpuSeconds: 1.1, totalFrames: 40, jankyFrames: 4 }), 120.0, 1.0)
    expect(p2.cpuPercent).toBeCloseTo(10.0, 6)
    expect(p2.memoryMb).toBeCloseTo(120.0, 9)
    expect(p2.fps).toBeCloseTo(30.0, 9)
    expect(p2.jankPercent).toBeCloseTo(10.0, 9)
    const gap = s.point(reading(undefined, 12.0), 120.0, 2.0)
    expect(gap.memoryMb).toBeUndefined()
    expect(gap.cpuPercent).toBeUndefined()
  })

  it('ringKeepsTheNewest', () => {
    const r = new RingSeries<number>(3)
    for (let i = 1; i <= 5; i++) r.add(i)
    expect(r.toList()).toEqual([3, 4, 5])
    r.clear()
    expect(r.size).toBe(0)
  })

  it('statsIgnoreGaps', () => {
    const s = Stats.of([10.0, undefined, 30.0, undefined])
    expect(s.current).toBeCloseTo(30.0, 9)
    expect(s.min).toBeCloseTo(10.0, 9)
    expect(s.avg).toBeCloseTo(20.0, 9)
    expect(s.max).toBeCloseTo(30.0, 9)
    expect(s.count).toBe(2)
    expect(Stats.of([undefined, undefined]).current).toBeUndefined()
    expect(Stats.format(undefined, ' MB')).toBe('-')
    expect(Stats.format(12.5, ' MB')).toBe('12.5 MB')
  })

  it('csv', () => {
    const csv = PerfCsv.toCsv([perfPoint(1.0, { memoryMb: 100.0, rssMb: 200.0, cpuPercent: 5.5, fps: 60.0 }), perfPoint(2.0)])
    expect(csv).toBe('seconds,memory_mb,rss_mb,cpu_percent,fps,janky_percent\n1.000,100.000,200.000,5.500,60.000,\n2.000,,,,,\n')
  })

  it('startHistoryAndSummary', () => {
    const h = new StartHistory(20)
    for (let i = 1; i <= 25; i++) h.add({ app: 'app', device: 'dev', kind: StartKind.COLD, millis: i, atMillis: i })
    expect(h.entries()).toHaveLength(20)
    expect(h.entries()[0].millis).toBe(25)
    const s = StartSummary.of([startRun(1, StartKind.COLD, 1000), startRun(2, StartKind.COLD, 1100), startRun(3, StartKind.COLD, undefined, 'x')])!
    expect(s.avg).toBe(1050)
    expect(s.min).toBe(1000)
    expect(s.max).toBe(1100)
    expect(s.count).toBe(2)
    expect(s.text()).toBe('Average: 1050 ms (min 1000, max 1100, 2 runs)')
    expect(StartSummary.of([])).toBeUndefined()
  })

  it('runnerStopsAtTheFirstFailureAndOnCancel', async () => {
    let calls = 0
    const backend: StartBackend = {
      async measure(): Promise<StartResult> {
        calls++
        if (calls === 3) throw new Error('boom\nsecond line')
        return startResult(100 * calls)
      },
    }
    const runs = await StartRunner.run(backend, 'a', StartKind.COLD, 5, () => false)
    expect(runs).toHaveLength(3)
    expect(runs[2].millis).toBeUndefined()
    expect(runs[2].note).toBe('boom')
    calls = 0
    let cancel = false
    const cancelled = await StartRunner.run(backend, 'a', StartKind.WARM, 10, () => cancel, undefined, (r) => {
      if (r.index === 1) cancel = true
    })
    expect(cancelled).toHaveLength(1)
    const always: StartBackend = { measure: async () => startResult(1) }
    expect(await StartRunner.run(always, 'a', StartKind.WARM, 99, () => false)).toHaveLength(10)
  })

  // ---- backends with a fake runner

  it('androidSampleUsesOneShellCall', async () => {
    const out = '1791120996.7\nPID=8642\n' + fixture('android-proc-stat-playground.txt') + fixture('android-proc-status-playground.txt') + 'Total frames rendered: 65\nJanky frames: 13 (20.00%)\n'
    const runner = new RecordingRunner(() => ok(out))
    const r = await new AndroidPerf('adb', 'emulator-5554', runner).sample('com.mobilenext.playground')
    expect(runner.commands).toHaveLength(1)
    expect(runner.commands[0].slice(0, 4)).toEqual(['adb', '-s', 'emulator-5554', 'shell'])
    expect(r.pid).toBe(8642)
    expect(r.cpuSeconds).toBeCloseTo(156.25, 9)
    expect(r.rssMb).toBeCloseTo(240640 / 1024.0, 9)
    expect(r.jankyFrames).toBe(13)
    expect((await new AndroidPerf('adb', 's', new RecordingRunner(() => ok('1.0\n'))).sample('a.b')).pid).toBeUndefined()
    await expect(new AndroidPerf('adb', 's', runner).sample('a;b')).rejects.toThrow(/valid/)
  })

  it('androidColdAndWarmStart', async () => {
    const steps: string[] = []
    let starts = 0
    const runner = new RecordingRunner((cmd) => {
      const line = cmd.slice(4).join(' ')
      steps.push(line)
      if (line.startsWith('am start')) starts++
      if (line.startsWith('cmd package')) return ok('priority=0\ncom.mobilenext.playground/.MainActivity\n')
      if (line.startsWith('am start') && starts === 1) return ok(fixture('android-am-start-W-cold.txt'))
      if (line.startsWith('am start')) return ok(fixture('android-am-start-W-warm-launcher-intent.txt'))
      if (line.startsWith('pidof')) return ok('8642\n')
      return ok('')
    })
    const perf = new AndroidPerf('adb', 'emulator-5554', runner, noSleep)
    const cold = await perf.measure('com.mobilenext.playground', StartKind.COLD)
    expect(cold.millis).toBe(34211)
    expect(steps.some((s) => s === 'am force-stop com.mobilenext.playground')).toBe(true)
    expect(steps.some((s) => s.includes('-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n com.mobilenext.playground/.MainActivity'))).toBe(true)
    steps.length = 0
    const warm = await perf.measure('com.mobilenext.playground', StartKind.WARM)
    expect(warm.millis).toBe(7879)
    expect(steps.some((s) => s === 'input keyevent KEYCODE_HOME')).toBe(true)
    expect(steps.some((s) => s.startsWith('am force-stop'))).toBe(false)
  })

  it('androidStartError', async () => {
    const runner = new RecordingRunner((cmd) => (cmd.includes('resolve-activity') ? ok('x/.A\n') : ok('Error type 3\nError: Activity class {x/.A} does not exist.\n', 1)))
    await expect(new AndroidPerf('adb', 's', runner, noSleep).measure('x', StartKind.COLD)).rejects.toThrow(/does not exist/)
  })

  it('iosSampleCombinesLaunchctlFootprintAndPs', async () => {
    let t = 100.0
    const runner = new RecordingRunner((cmd) => {
      if (cmd.includes('launchctl')) return ok(fixture('ios-simctl-launchctl-playground.txt'))
      if (cmd[0] === 'footprint') return ok(fixture('ios-footprint-playground.txt'))
      return ok(fixture('ios-ps-time-playground.txt'))
    })
    const r = await new IosPerf('xcrun', 'UDID', runner, async () => {}, noSleep, undefined, () => (t += 0.5)).sample('com.mobilenext.playground')
    expect(r.pid).toBe(35979)
    expect(r.cpuSeconds).toBeCloseTo(1.8, 9)
    expect(r.memoryMb).toBeCloseTo(27.55, 1)
    expect((await new IosPerf('xcrun', 'UDID', new RecordingRunner(() => ok('PID\tStatus\tLabel\n')), async () => {}, noSleep).sample('com.x')).pid).toBeUndefined()
    // footprint says the pid is gone
    const gone = new RecordingRunner((cmd) => (cmd.includes('launchctl') ? ok(fixture('ios-simctl-launchctl-playground.txt')) : ok(fixture('ios-footprint-no-process.txt'), 66)))
    expect((await new IosPerf('xcrun', 'UDID', gone, async () => {}, noSleep).sample('com.mobilenext.playground')).pid).toBeUndefined()
  })

  it('iosColdStartTimedFromTheLogWithFallback', async () => {
    const steps: string[] = []
    const recorded: string[][] = []
    const runnerFor = (log: string) =>
      new RecordingRunner((cmd) => {
        steps.push(cmd.slice(2).join(' ').slice(0, 40))
        recorded.push(cmd)
        if (cmd.includes('terminate')) return ok('', 3)
        if (cmd.includes('launch') && cmd.includes('simctl') && cmd[2] === 'launch') return ok('com.mobilenext.playground: 36136\n')
        if (cmd.includes('log')) return ok(log)
        return ok('')
      })
    const perf = new IosPerf('xcrun', 'U', runnerFor(fixture('ios-log-show-launch-cold.txt')), async () => {}, noSleep, () => new Date(2026, 9, 4, 15, 46, 51))
    const cold = await perf.measure('com.mobilenext.playground', StartKind.COLD)
    expect(cold.millis).toBe(1061)
    expect(steps[0].startsWith('terminate')).toBe(true)
    const logCmd = recorded.find((c) => c.includes('log') && c.includes('show'))!
    expect(logCmd[logCmd.indexOf('--start') + 1]).toBe('2026-10-04 15:46:50')
    expect(logCmd[logCmd.indexOf('--predicate') + 1]).toBe(IosPerfParsers.logPredicate('com.mobilenext.playground'))
    const fallback = await new IosPerf('xcrun', 'U', runnerFor(''), async () => {}, noSleep).measure('com.mobilenext.playground', StartKind.COLD)
    expect(fallback.millis).toBeDefined()
    expect(fallback.note).toContain('fallback')
  })

  it('iosFootprintFailureIsAnErrorNotNotRunning', async () => {
    const runner = new RecordingRunner((cmd) => (cmd.includes('launchctl') ? ok(fixture('ios-simctl-launchctl-playground.txt')) : new CommandResult(1, Buffer.alloc(0), 'footprint: timed out')))
    const promise = new IosPerf('xcrun', 'U', runner, async () => {}, noSleep).sample('com.mobilenext.playground')
    await expect(promise).rejects.toBeInstanceOf(PerfException)
    await expect(promise).rejects.toThrow(/timed out/)
  })

  it('androidProbeScriptAlwaysExitsZero', () => {
    expect(AndroidPerfParsers.probeScript('com.x').trimEnd().endsWith('; true')).toBe(true)
  })

  it('iosWarmStartPressesHome', async () => {
    let homes = 0
    const runner = new RecordingRunner((cmd) => {
      if (cmd.includes('launchctl')) return ok(fixture('ios-simctl-launchctl-playground.txt'))
      if (cmd.includes('log')) return ok('')
      if (cmd.includes('launch')) return ok('com.mobilenext.playground: 36136\n')
      return ok('')
    })
    await new IosPerf('xcrun', 'U', runner, async () => void homes++, noSleep).measure('com.mobilenext.playground', StartKind.WARM)
    expect(homes).toBe(1)
    expect(runner.commands.some((c) => c.includes('terminate'))).toBe(false)
  })
})
