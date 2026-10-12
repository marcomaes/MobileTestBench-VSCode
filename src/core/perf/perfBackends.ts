// ported-from: core/perf/PerfBackends.kt
import type { CommandRunner } from '../exec/commandRunner'
import { reading, startResult, type Reading, type StartBackend, type StartKind, type StartResult } from './perfModel'
import { AndroidPerfParsers, IosPerfParsers, type AmStartResult } from './perfParsers'

/** What the Performance tab reads and measures on one device. All calls are async. */
export interface PerfBackend extends StartBackend {
  /** True when frame statistics exist (Android only). */
  readonly hasFrames: boolean
  /** Label of the memory number plotted: what it is, for the chart title. */
  readonly memoryLabel: string
  /** One reading of [app] (package name or bundle id). A reading with an undefined pid means the app is not running. */
  sample(app: string): Promise<Reading>
  /** A slow, accurate memory reading in MB (Android PSS, seconds per call); undefined when the backend has none or it failed. */
  pssMb?(app: string): Promise<number | undefined>
}

export class PerfException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfException'
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const nanoClock = (): number => performance.now() / 1000
const firstNonEmpty = (...values: string[]): string => values.find((v) => v.length > 0) ?? ''

/** USER_HZ, 100 on virtually every Android kernel (read from `getconf CLK_TCK` on an emulator only). */
const CLK_TCK = 100.0

/** Android through adb: one shell call per second (see [AndroidPerfParsers.probeScript]), PSS through a slower `dumpsys meminfo`, start time through `am start -W`. */
export class AndroidPerf implements PerfBackend {
  readonly hasFrames = true
  readonly memoryLabel = 'PSS (updated every 5 s) and RSS'
  private resolved: [string, string] | undefined

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  private shell(timeoutMs: number, ...args: string[]) {
    return this.runner.run([this.adb, '-s', this.serial, 'shell', ...args], timeoutMs)
  }

  private requireSafe(app: string): void {
    if (!AndroidPerfParsers.isSafeId(app)) throw new PerfException(`Not a valid package name: ${app}`)
  }

  async sample(app: string): Promise<Reading> {
    this.requireSafe(app)
    const result = await this.shell(15_000, AndroidPerfParsers.probeScript(app))
    if (!result.ok) throw new PerfException(`adb failed: ${firstNonEmpty(result.stderr.trim(), result.text.trim())}`)
    const p = AndroidPerfParsers.parseProbe(result.text)
    const clock = p.deviceSeconds ?? nanoClock()
    if (p.pid === undefined) return reading(undefined, clock)
    return reading(p.pid, clock, {
      rssMb: p.rssKb === undefined ? undefined : p.rssKb / 1024.0,
      cpuSeconds: p.cpuTicks === undefined ? undefined : p.cpuTicks / CLK_TCK,
      totalFrames: p.totalFrames,
      jankyFrames: p.jankyFrames,
    })
  }

  async pssMb(app: string): Promise<number | undefined> {
    this.requireSafe(app)
    const result = await this.shell(25_000, 'dumpsys', 'meminfo', app)
    const kb = AndroidPerfParsers.parsePssKb(result.text)
    return kb === undefined ? undefined : kb / 1024.0
  }

  private async component(app: string): Promise<string> {
    if (this.resolved && this.resolved[0] === app) return this.resolved[1]
    const out = (await this.shell(15_000, 'cmd', 'package', 'resolve-activity', '--brief', app)).text
    const c = AndroidPerfParsers.parseResolvedActivity(out)
    if (c === undefined) throw new PerfException(`No launchable activity found for ${app} (is it installed?)`)
    this.resolved = [app, c]
    return c
  }

  private async start(component: string): Promise<AmStartResult> {
    // The launcher style intent: after HOME a plain `am start -n` only brings the task to the front and prints no TotalTime.
    const r = await this.shell(90_000, 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000', '-n', component)
    const parsed = AndroidPerfParsers.parseAmStart(r.text)
    if (!r.ok || parsed.error !== undefined) throw new PerfException(parsed.error ?? firstNonEmpty(r.text.trim(), r.stderr.trim()))
    return parsed
  }

  private async running(app: string): Promise<boolean> {
    return AndroidPerfParsers.firstPid((await this.shell(10_000, 'pidof', app)).text) !== undefined
  }

  async measure(app: string, kind: StartKind): Promise<StartResult> {
    this.requireSafe(app)
    const comp = await this.component(app)
    if (kind === 'COLD') {
      await this.shell(15_000, 'am', 'force-stop', app)
      await this.sleep(1500)
    } else {
      if (!(await this.running(app))) {
        await this.start(comp)
        await this.sleep(3000)
      }
      await this.shell(10_000, 'input', 'keyevent', 'KEYCODE_HOME')
      await this.sleep(2000)
    }
    const r = await this.start(comp)
    const expected = kind === 'COLD' ? 'COLD' : 'WARM'
    const state = r.launchState ?? 'unknown'
    const total = r.totalMs !== undefined && r.totalMs > 0 ? r.totalMs : undefined
    if (total !== undefined) return startResult(total, `TotalTime, ${state}` + (!state.startsWith(expected) ? ` (expected ${expected})` : ''))
    if (r.waitMs !== undefined) return startResult(r.waitMs, `WaitTime only (no TotalTime), ${state}` + (r.warning !== undefined ? `: ${r.warning}` : ''))
    throw new PerfException('am start printed no timing' + (r.warning !== undefined ? `: ${r.warning}` : ''))
  }
}

/**
 * iOS simulator. The app is a macOS process: pid from `launchctl list` inside the simulator, memory from `footprint` (physical footprint, not the much
 * larger rss), CPU from the delta of `ps` CPU time. No frame statistics exist without Instruments. Start time comes from the simulator log
 * (launch request to UIApplication active) and falls back to the duration of the launch call, which only times the spawn.
 */
export class IosPerf implements PerfBackend {
  readonly hasFrames = false
  readonly memoryLabel = 'Footprint'

  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
    /** Presses the home button (a mobilecli call). */
    private readonly goHome: () => Promise<void>,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => Date = () => new Date(),
    private readonly clock: () => number = nanoClock,
  ) {}

  private simctl(timeoutMs: number, ...args: string[]) {
    return this.runner.run([this.xcrun, 'simctl', ...args], timeoutMs)
  }

  private async pidOf(app: string): Promise<number | undefined> {
    const r = await this.simctl(15_000, 'spawn', this.udid, 'launchctl', 'list')
    return IosPerfParsers.launchctlPid(r.text, app)
  }

  async sample(app: string): Promise<Reading> {
    if (!AndroidPerfParsers.isSafeId(app)) throw new PerfException(`Not a valid bundle id: ${app}`)
    const pid = await this.pidOf(app)
    if (pid === undefined) return reading(undefined, this.clock())
    const footprint = await this.runner.run(['footprint', '-p', String(pid), '-f', 'bytes'], 10_000)
    const memory = IosPerfParsers.footprintMb(footprint.text)
    if (memory === undefined) {
      // "Unable to find pid" means the app exited since launchctl listed it; anything else is a tool failure the user should see.
      const said = firstNonEmpty(footprint.stderr.trim(), footprint.text.trim())
      if (said.length === 0 || said.includes('Unable to find')) return reading(undefined, this.clock())
      throw new PerfException(`footprint failed: ${said.split(/\r?\n/)[0]}`)
    }
    const before = this.clock()
    const ps = await this.runner.run(['ps', '-o', 'pid=,rss=,time=,etime=', '-p', String(pid)], 10_000)
    const after = this.clock()
    const cpu = IosPerfParsers.psCpuSeconds(ps.text)
    if (cpu === undefined) {
      // ps prints nothing when the pid is gone; unparsable output is a real failure.
      if (ps.text.trim().length === 0) return reading(undefined, after)
      throw new PerfException(`ps failed: ${firstNonEmpty(ps.stderr.trim(), ps.text.trim()).split(/\r?\n/)[0]}`)
    }
    return reading(pid, (before + after) / 2, { memoryMb: memory, cpuSeconds: cpu })
  }

  async measure(app: string, kind: StartKind): Promise<StartResult> {
    if (!AndroidPerfParsers.isSafeId(app)) throw new PerfException(`Not a valid bundle id: ${app}`)
    if (kind === 'COLD') {
      // Terminating an app that is not running fails; that is fine here.
      await this.simctl(20_000, 'terminate', this.udid, app)
      await this.sleep(1500)
    } else {
      if ((await this.pidOf(app)) === undefined) {
        await this.launch(app)
        await this.sleep(3000)
      }
      await this.goHome()
      await this.sleep(2000)
    }
    const begin = new Date(this.now().getTime() - 1000)
    const t0 = this.clock()
    const [pid] = await this.launch(app)
    const callMs = Math.round((this.clock() - t0) * 1000)
    await this.sleep(2500) // the unified log lags behind
    let log = ''
    try {
      log = (
        await this.runner.run(
          [this.xcrun, 'simctl', 'spawn', this.udid, 'log', 'show', '--start', IosPerfParsers.logStartArgument(begin), '--style', 'compact', '--predicate', IosPerfParsers.logPredicate(app)],
          40_000,
        )
      ).text
    } catch {
      log = ''
    }
    const ms = IosPerfParsers.launchMillis(log, app, pid)
    return ms !== undefined ? startResult(ms, 'simulator log: launch request to active') : startResult(callMs, 'fallback: the launch call only, which times the spawn, not the start')
  }

  private async launch(app: string): Promise<[number | undefined, string]> {
    const r = await this.simctl(60_000, 'launch', this.udid, app)
    if (!r.ok) throw new PerfException(firstNonEmpty(r.stderr.trim(), r.text.trim(), 'simctl launch failed'))
    return [IosPerfParsers.launchOutputPid(r.text), r.text]
  }
}
