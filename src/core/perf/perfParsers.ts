// ported-from: core/perf/PerfParsers.kt

/** What one Android probe call read. Every field is undefined when its source was missing from the output. */
export interface AndroidProbe {
  /** Device clock in seconds (`date +%s.%N`). */
  readonly deviceSeconds: number | undefined
  /** The first pid of `pidof`; undefined when the app is not running. */
  readonly pid: number | undefined
  /** utime + stime of /proc/<pid>/stat in clock ticks. */
  readonly cpuTicks: number | undefined
  readonly rssKb: number | undefined
  readonly swapKb: number | undefined
  readonly totalFrames: number | undefined
  readonly jankyFrames: number | undefined
}

/** The result of `am start -W`. */
export interface AmStartResult {
  /** `COLD`, `WARM`, `HOT` or `UNKNOWN (0)` as printed. */
  readonly launchState: string | undefined
  readonly totalMs: number | undefined
  readonly waitMs: number | undefined
  /** The `Warning:` text, if any. */
  readonly warning: string | undefined
  /** An error text (`Error:` line or `Status:` other than ok); undefined when the start worked. */
  readonly error: string | undefined
}

const lines = (s: string): string[] => s.split(/\r\n|\n|\r/)
const toLongOrNull = (s: string | undefined): number | undefined => (s !== undefined && /^[+-]?\d+$/.test(s) ? Number(s) : undefined)
const toDoubleOrNull = (s: string | undefined): number | undefined =>
  s !== undefined && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : undefined
const substringAfter = (s: string, c: string): string => (s.includes(c) ? s.slice(s.indexOf(c) + c.length) : s)

/** Parsers for the Android side: `/proc`, `dumpsys meminfo` and `gfxinfo`, `pidof`, `am start -W`. Pure. */
export const AndroidPerfParsers = {
  /** Package names and bundle ids are put into a shell script, so only these characters are allowed. */
  isSafeId: (id: string): boolean => id.length > 0 && id.length <= 200 && /^[\p{L}\p{Nd}._-]+$/u.test(id),

  /** The one adb shell script that reads clock, pid, cpu ticks, rss and the frame counters of [pkg] in a single call. */
  probeScript: (pkg: string): string =>
    `p=$(pidof ${pkg}); set -- $p; p=$1; date +%s.%N; ` +
    `if [ -n "$p" ]; then echo "PID=$p"; cat /proc/$p/stat; grep -E 'VmRSS|VmSwap' /proc/$p/status; fi; ` +
    `dumpsys gfxinfo ${pkg} | grep -E 'Total frames|Janky frames:'; true`,

  parseProbe(output: string): AndroidProbe {
    const clockRegex = /^\d+(\.\d+)?$/
    const pidRegex = /^PID=(\d+)/
    const kbRegex = /^(VmRSS|VmSwap):\s*(\d+)\s*kB/
    const totalRegex = /^\s*Total frames rendered:\s*(\d+)/
    const jankyRegex = /^\s*Janky frames:\s*(\d+)\s*\(/
    let clock: number | undefined
    let pid: number | undefined
    let ticks: number | undefined
    let rss: number | undefined
    let swap: number | undefined
    let total: number | undefined
    let janky: number | undefined
    for (const raw of lines(output)) {
      const line = raw.trim()
      if (line.length === 0) continue
      if (clock === undefined && clockRegex.test(line)) {
        clock = Number(line)
        continue
      }
      const pm = pidRegex.exec(line)
      if (pm) pid = Number(pm[1])
      const km = kbRegex.exec(line)
      if (km) {
        if (km[1] === 'VmRSS') rss = Number(km[2])
        else swap = Number(km[2])
      }
      const tm = totalRegex.exec(line)
      if (tm) total = Number(tm[1])
      const jm = jankyRegex.exec(line)
      if (jm) janky = Number(jm[1])
      if (ticks === undefined && line.includes(')') && /^\d/.test(line)) ticks = AndroidPerfParsers.statTicks(line)
    }
    return { deviceSeconds: clock, pid, cpuTicks: ticks, rssKb: rss, swapKb: swap, totalFrames: total, jankyFrames: janky }
  },

  /**
   * utime + stime (fields 14 and 15) of a `/proc/<pid>/stat` line. The command name is in parentheses and may contain spaces, so the fields are
   * counted after the LAST `)`.
   */
  statTicks(line: string): number | undefined {
    const rest = line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)
    const utime = toLongOrNull(rest[11])
    if (utime === undefined) return undefined
    const stime = toLongOrNull(rest[12])
    if (stime === undefined) return undefined
    return utime + stime
  },

  /** First pid of `pidof` output (several space separated pids for a multi process app), or undefined. */
  firstPid: (output: string): number | undefined => toLongOrNull(output.trim().split(/\s+/)[0]),

  /** Total PSS in KB from `dumpsys meminfo <pkg>`; undefined when the package is not running or the dump timed out (it prints that with exit code 0). */
  parsePssKb(output: string): number | undefined {
    if (output.includes('No process found')) return undefined
    const m = /TOTAL PSS:\s+(\d+)/.exec(output) ?? /^\s*TOTAL\s+(\d+)\s/m.exec(output)
    return toLongOrNull(m?.[1])
  },

  /** The frame counters of `dumpsys gfxinfo <pkg>`: [total frames, janky frames] or undefined when missing. */
  parseGfxinfo(output: string): [number, number] | undefined {
    let total: number | undefined
    let janky: number | undefined
    for (const line of lines(output)) {
      const t = /^\s*Total frames rendered:\s*(\d+)/.exec(line)
      if (t) total = Number(t[1])
      const j = /^\s*Janky frames:\s*(\d+)\s*\(/.exec(line)
      if (j) janky = Number(j[1])
    }
    return total !== undefined && janky !== undefined ? [total, janky] : undefined
  },

  /** `adb shell cmd package resolve-activity --brief <pkg>`: the last line that looks like `pkg/.Activity`. */
  parseResolvedActivity(output: string): string | undefined {
    const found = lines(output)
      .map((l) => l.trim())
      .filter((l) => l.includes('/') && !l.includes(' '))
    return found.length ? found[found.length - 1] : undefined
  },

  parseAmStart(output: string): AmStartResult {
    let state: string | undefined
    let total: number | undefined
    let wait: number | undefined
    let warning: string | undefined
    let error: string | undefined
    for (const raw of lines(output)) {
      const line = raw.trim()
      const after = substringAfter(line, ':').trim()
      if (line.startsWith('LaunchState:')) state = after
      else if (line.startsWith('TotalTime:')) total = toLongOrNull(after)
      else if (line.startsWith('WaitTime:')) wait = toLongOrNull(after)
      else if (line.startsWith('Warning:')) warning = after
      else if (line.startsWith('Error:')) error = error ?? after
      else if (line.startsWith('Status:') && after.toLowerCase() !== 'ok') error = error ?? line
    }
    return { launchState: state, totalMs: total, waitMs: wait, warning, error }
  },
}

const toUtcMs = (m: RegExpExecArray): number => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] ?? 0))
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Parsers for the iOS simulator side (the app is a normal macOS process): launchctl, footprint, ps and the launch log. Pure. */
export const IosPerfParsers = {
  /** The pid of [bundleId] from `simctl spawn <udid> launchctl list`; undefined when it is not running. Matches the literal prefix so com.foo does not match com.foo.bar. */
  launchctlPid(output: string, bundleId: string): number | undefined {
    const prefix = `UIKitApplication:${bundleId}[`
    for (const line of lines(output)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 3 && cols[2].startsWith(prefix)) return toLongOrNull(cols[0])
    }
    return undefined
  },

  /** The physical footprint in MB from `footprint -p <pid> -f bytes`; undefined when the process is gone. */
  footprintMb(output: string): number | undefined {
    const b = toLongOrNull(/\[(\d+)\]:.*Footprint:\s*(\d+) B/.exec(output)?.[2])
    return b === undefined ? undefined : b / 1_048_576.0
  },

  /**
   * Cumulative CPU time in seconds from `ps -o pid=,rss=,time=,etime= -p <pid>` (third column, `M:SS.hh`, `H:MM:SS.hh` or `D-HH:MM:SS`);
   * undefined when ps printed nothing (the process is gone).
   */
  psCpuSeconds(output: string): number | undefined {
    const cols = lines(output.trim())[0]?.trim().split(/\s+/)
    const c = cols?.[2]
    return c === undefined ? undefined : IosPerfParsers.parseCpuTime(c)
  },

  parseCpuTime(text: string): number | undefined {
    let rest = text
    let days = 0.0
    if (rest.includes('-')) {
      const d = toDoubleOrNull(rest.slice(0, rest.indexOf('-')))
      if (d === undefined) return undefined
      days = d
      rest = rest.slice(rest.indexOf('-') + 1)
    }
    const parts = rest.split(':')
    if (parts.length > 3) return undefined
    let seconds = 0.0
    for (const p of parts) {
      const v = toDoubleOrNull(p)
      if (v === undefined) return undefined
      seconds = seconds * 60 + v
    }
    return seconds + days * 86400
  },

  /** Host local time in the format `log show --start` takes (the Kotlin LocalDateTime is a JS Date read in local time). */
  logStartArgument: (time: Date): string =>
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`,

  /** The predicate that selects the launch request, its result and the app's UIKit lifecycle lines. */
  logPredicate: (bundleId: string): string =>
    `eventMessage CONTAINS "Deactivation reason" OR eventMessage CONTAINS "Requesting launch of ${bundleId}" OR eventMessage CONTAINS "Launch successful for"`,

  /**
   * Start time in ms from the simulator's unified log: the last "Requesting launch of <bundle>" line to the last
   * "Deactivation reason ... -> 0;" line of the app process (UIApplication became active). Undefined when either is missing.
   * [pid] is the app's pid from the launch call; when undefined the pid of the "Launch successful" line is used. This reads undocumented UIKit
   * debug text and includes the system launch animation.
   */
  launchMillis(log: string, bundleId: string, pid: number | undefined): number | undefined {
    const stamp = (line: string): number | undefined => {
      const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(line.slice(0, 23))
      return m ? toUtcMs(m) : undefined
    }
    const pidInLine = /\[(\d+):[0-9a-f]+\]/
    const launchPid = /Launch successful for '[^']*', pid: (\d+)/
    const all = lines(log).filter((l) => l.length > 24 && /\d/.test(l[0]) && l[4] === '-')
    const last = (pred: (l: string) => boolean): string | undefined => [...all].reverse().find(pred)
    const request = last((l) => l.includes(`Requesting launch of ${bundleId} `))
    if (request === undefined) return undefined
    let appPid = pid
    if (appPid === undefined) {
      const ok = last((l) => l.includes(`Launch successful for '${bundleId}'`))
      appPid = ok === undefined ? undefined : toLongOrNull(launchPid.exec(ok)?.[1])
      if (appPid === undefined) return undefined
    }
    const active = last((l) => l.includes('Deactivation reason') && l.includes('-> 0;') && toLongOrNull(pidInLine.exec(l)?.[1]) === appPid)
    if (active === undefined) return undefined
    const start = stamp(request)
    const end = stamp(active)
    if (start === undefined || end === undefined) return undefined
    const ms = end - start
    return ms >= 0 ? ms : undefined
  },

  /** `com.foo: 12345` printed by `simctl launch`. */
  launchOutputPid(output: string): number | undefined {
    const t = output.trim()
    const i = t.lastIndexOf(':')
    return i < 0 ? undefined : toLongOrNull(t.slice(i + 1).trim())
  },
}
