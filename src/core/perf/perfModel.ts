// ported-from: core/perf/PerfModel.kt

/** One reading of the app by a backend. [pid] undefined means the app is not running. */
export interface Reading {
  readonly pid: number | undefined
  /** Clock for the CPU and frame deltas in seconds (device clock on Android, host clock on iOS). */
  readonly clockSeconds: number
  /** Memory in MB that needs no slow call (iOS footprint); undefined on Android (PSS comes from its own slower call). */
  readonly memoryMb?: number
  /** Resident set size in MB (Android only). */
  readonly rssMb?: number
  /** Cumulative CPU time of the process in seconds. */
  readonly cpuSeconds?: number
  readonly totalFrames?: number
  readonly jankyFrames?: number
}

/** `Reading(pid, clock, rssMb = ...)` of the Kotlin code. */
export const reading = (pid: number | undefined, clockSeconds: number, rest: Partial<Omit<Reading, 'pid' | 'clockSeconds'>> = {}): Reading => ({ pid, clockSeconds, ...rest })

/** One chart point. [seconds] is the time since sampling started; undefined values are gaps (app not running, no baseline yet, no frames rendered). */
export interface PerfPoint {
  readonly seconds: number
  readonly memoryMb?: number
  readonly rssMb?: number
  readonly cpuPercent?: number
  readonly fps?: number
  readonly jankPercent?: number
}

export const perfPoint = (seconds: number, rest: Partial<Omit<PerfPoint, 'seconds'>> = {}): PerfPoint => ({ seconds, ...rest })

/** CPU time deltas to percent of one core (can exceed 100 on several cores). The first reading of a pid only sets the baseline. */
export class CpuTracker {
  private pid: number | undefined
  private lastCpu = 0.0
  private lastClock = 0.0

  update(pid: number | undefined, cpuSeconds: number | undefined, clockSeconds: number): number | undefined {
    if (pid === undefined || cpuSeconds === undefined) {
      this.pid = undefined
      return undefined
    }
    const previous = this.pid
    const dCpu = cpuSeconds - this.lastCpu
    const dClock = clockSeconds - this.lastClock
    this.pid = pid
    this.lastCpu = cpuSeconds
    this.lastClock = clockSeconds
    if (previous !== pid || dClock <= 0.0 || dCpu < 0.0) return undefined
    return (dCpu / dClock) * 100.0
  }
}

/** Frame statistics of one interval. [jankPercent] is undefined when no frame was rendered (an idle app). */
export interface FrameStats {
  readonly fps: number
  readonly jankPercent: number | undefined
}

/** Cumulative gfxinfo counters to the frames per second and janky percentage of each interval. A counter that goes down means a restart or a reset: re-baseline. */
export class FrameDelta {
  private pid: number | undefined
  private lastTotal = 0
  private lastJanky = 0
  private lastClock = 0.0

  update(pid: number | undefined, total: number | undefined, janky: number | undefined, clockSeconds: number): FrameStats | undefined {
    if (pid === undefined || total === undefined || janky === undefined) {
      this.pid = undefined
      return undefined
    }
    const previous = this.pid
    const dTotal = total - this.lastTotal
    const dJanky = janky - this.lastJanky
    const dClock = clockSeconds - this.lastClock
    this.pid = pid
    this.lastTotal = total
    this.lastJanky = janky
    this.lastClock = clockSeconds
    if (previous !== pid || dClock <= 0.0 || dTotal < 0 || dJanky < 0) return undefined
    return { fps: dTotal / dClock, jankPercent: dTotal === 0 ? undefined : (dJanky * 100.0) / dTotal }
  }
}

/** Turns readings into [PerfPoint]s. */
export class PerfSampler {
  private readonly cpu = new CpuTracker()
  private readonly frames = new FrameDelta()

  /** [pssMb] is the last known PSS (Android), held between the slower dumpsys calls. */
  point(r: Reading, pssMb: number | undefined, elapsedSeconds: number): PerfPoint {
    if (r.pid === undefined) {
      this.cpu.update(undefined, undefined, r.clockSeconds)
      this.frames.update(undefined, undefined, undefined, r.clockSeconds)
      return perfPoint(elapsedSeconds)
    }
    const c = this.cpu.update(r.pid, r.cpuSeconds, r.clockSeconds)
    const f = this.frames.update(r.pid, r.totalFrames, r.jankyFrames, r.clockSeconds)
    return { seconds: elapsedSeconds, memoryMb: r.memoryMb ?? pssMb, rssMb: r.rssMb, cpuPercent: c, fps: f?.fps, jankPercent: f?.jankPercent }
  }
}

/** A fixed size ring buffer: the newest [capacity] items. */
export class RingSeries<T> {
  private items: T[] = []
  constructor(readonly capacity: number) {}

  get size(): number {
    return this.items.length
  }

  add(item: T): void {
    this.items.push(item)
    while (this.items.length > this.capacity) this.items.shift()
  }

  toList(): T[] {
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }
}

/** Readouts of a series; gaps (undefined) are ignored. */
export class Stats {
  constructor(
    readonly current: number | undefined,
    readonly min: number | undefined,
    readonly avg: number | undefined,
    readonly max: number | undefined,
    readonly count: number,
  ) {}

  static of(values: ReadonlyArray<number | undefined>): Stats {
    const real = values.filter((v): v is number => v !== undefined && v !== null)
    if (real.length === 0) return new Stats(undefined, undefined, undefined, undefined, 0)
    // "now" is the newest value of the series, also when it is older than a trailing gap.
    let min = real[0]
    let max = real[0]
    let sum = 0
    for (const v of real) {
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    return new Stats(real[real.length - 1], min, sum / real.length, max, real.length)
  }

  static format(value: number | undefined, unit: string, decimals = 1): string {
    return value === undefined || value === null ? '-' : value.toFixed(decimals) + unit
  }
}

/** The samples as CSV (comma separated, dot decimals, empty cell for a gap). */
export const PerfCsv = {
  HEADER: 'seconds,memory_mb,rss_mb,cpu_percent,fps,janky_percent',

  toCsv(points: readonly PerfPoint[]): string {
    let out = PerfCsv.HEADER + '\n'
    for (const p of points) {
      out += [p.seconds, p.memoryMb, p.rssMb, p.cpuPercent, p.fps, p.jankPercent].map((v) => (v === undefined || v === null ? '' : v.toFixed(3))).join(',') + '\n'
    }
    return out
  },
}

export const StartKind = { COLD: 'COLD', WARM: 'WARM' } as const
export type StartKind = (typeof StartKind)[keyof typeof StartKind]
export const startKindLabel = (kind: StartKind): string => (kind === 'COLD' ? 'Cold' : 'Warm')
export const startKinds: readonly StartKind[] = ['COLD', 'WARM']

/** One measured start. [millis] undefined: the run failed, see [note]. */
export interface StartRun {
  readonly index: number
  readonly kind: StartKind
  readonly millis: number | undefined
  readonly note: string
}

export const startRun = (index: number, kind: StartKind, millis: number | undefined, note = ''): StartRun => ({ index, kind, millis, note })

export class StartSummary {
  constructor(
    readonly count: number,
    readonly avg: number,
    readonly min: number,
    readonly max: number,
  ) {}

  text(): string {
    return `Average: ${this.avg} ms (min ${this.min}, max ${this.max}, ${this.count} run${this.count === 1 ? '' : 's'})`
  }

  static of(runs: readonly StartRun[]): StartSummary | undefined {
    const ms = runs.map((r) => r.millis).filter((m): m is number => m !== undefined)
    if (ms.length === 0) return undefined
    return new StartSummary(ms.length, Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), Math.min(...ms), Math.max(...ms))
  }
}

/** A remembered measurement with where it was taken. */
export interface StartEntry {
  readonly app: string
  readonly device: string
  readonly kind: StartKind
  readonly millis: number
  readonly atMillis: number
}

/** The last [limit] measurements, newest first. Kept in memory for the session. */
export class StartHistory {
  private items: StartEntry[] = []
  constructor(private readonly limit = 20) {}

  add(entry: StartEntry): void {
    this.items.unshift(entry)
    while (this.items.length > this.limit) this.items.pop()
  }

  entries(): StartEntry[] {
    return [...this.items]
  }
}

/** A start measured by a backend: [millis] plus a plain note on how it was measured or what was odd. */
export interface StartResult {
  readonly millis: number | undefined
  readonly note: string
}

export const startResult = (millis: number | undefined, note = ''): StartResult => ({ millis, note })

/** The platform part of a start measurement: one cold or warm start of [app]. Throws with a readable message on failure. */
export interface StartBackend {
  measure(app: string, kind: StartKind): Promise<StartResult>
}

/** Runs N measurements in a row; stops at the first failure (a failed cold start has killed the app already) or when cancelled. */
export const StartRunner = {
  async run(
    backend: StartBackend,
    app: string,
    kind: StartKind,
    runs: number,
    cancelled: () => boolean,
    progress: (done: number, total: number) => void = () => {},
    onRun: (run: StartRun) => void = () => {},
  ): Promise<StartRun[]> {
    const results: StartRun[] = []
    const count = Math.min(10, Math.max(1, runs))
    for (let i = 1; i <= count; i++) {
      if (cancelled()) break
      progress(i - 1, runs)
      let run: StartRun
      try {
        const r = await backend.measure(app, kind)
        run = startRun(i, kind, r.millis, r.note)
      } catch (e) {
        const err = e as Error
        run = startRun(i, kind, undefined, err.message?.split(/\r?\n/).find((l) => l.trim().length > 0) ?? err.name ?? 'Error')
      }
      results.push(run)
      onRun(run)
      if (run.millis === undefined) break
    }
    return results
  },
}
