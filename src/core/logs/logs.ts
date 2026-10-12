// ported-from: core/logs/Logs.kt
// Split from the Kotlin file: LogStream (needs node:child_process) lives in logStream.ts so this file stays usable in the webview.

export enum LogLevel {
  VERBOSE,
  DEBUG,
  INFO,
  WARN,
  ERROR,
  FATAL,
}

const LEVEL_LABELS = ['Verbose', 'Debug', 'Info', 'Warn', 'Error', 'Fatal']

/** The display name of a level (the Kotlin `LogLevel.label`). */
export const logLevelLabel = (level: LogLevel): string => LEVEL_LABELS[level]

/** The enum name of a level (`ERROR`), the Kotlin `LogLevel.name`. */
export const logLevelName = (level: LogLevel): string => LogLevel[level]

/** One log line. [tag] is the logcat tag on Android and the process name on iOS. */
export class LogEntry {
  constructor(
    readonly time: string,
    readonly level: LogLevel,
    readonly tag: string,
    readonly pid: string,
    public message: string,
  ) {}

  toString(): string {
    return `${this.time} ${logLevelName(this.level)[0]} ${this.tag}[${this.pid}]: ${this.message}`
  }
}

export const AndroidLogParser = {
  // 10-04 11:03:54.483  2683  2686 I artd    : message   (logcat -v threadtime)
  line: /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+\d+\s+([VDIWEFA])\s+(.*?)\s*: ?(.*)$/s,

  parse(text: string): LogEntry | undefined {
    const m = this.line.exec(text)
    if (!m) return undefined
    const level = (
      { V: LogLevel.VERBOSE, D: LogLevel.DEBUG, I: LogLevel.INFO, W: LogLevel.WARN, E: LogLevel.ERROR } as Record<string, LogLevel>
    )[m[3]] ?? LogLevel.FATAL
    return new LogEntry(m[1], level, m[4], m[2], m[5])
  },
}

export const IosLogParser = {
  // 2026-10-04 11:04:04.085 Df mediaanalysisd[6729:1cb721] message   (log stream --style compact)
  line: /^\d{4}-(\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) (\w{1,2})\s+(.+?)\[(\d+):[0-9a-fA-F]+\] ?(.*)$/s,

  parse(text: string): LogEntry | undefined {
    const m = this.line.exec(text)
    if (!m) return undefined
    const level = m[3] === 'Db' ? LogLevel.DEBUG : m[3] === 'E' ? LogLevel.ERROR : m[3] === 'F' ? LogLevel.FATAL : LogLevel.INFO // Df (default), I (info), A (activity)
    return new LogEntry(`${m[1]} ${m[2]}`, level, m[4], m[5], m[6])
  },
}

/** A range of characters, both ends inclusive (the Kotlin IntRange). */
export interface IntRange {
  first: number
  last: number
}

/** Regular expressions only look at this much of a message: a cap against slow patterns on huge lines. */
const MAX_REGEX_INPUT = 20_000
const MAX_RANGES = 100

interface Compiled {
  pattern?: RegExp
  error?: string
}

export interface LogFilterOptions {
  minLevel?: LogLevel
  /** Case insensitive text in the message (a regular expression when [regex] is on). */
  text?: string
  /** Case insensitive text in the tag (Android) or process (iOS) (a regular expression when [regex] is on). */
  tag?: string
  /** The app by package or process name. Blank: every app. */
  app?: string
  /** The process ids of [app] on Android (from `pidof`); undefined when they are not looked up, e.g. on iOS. */
  appPids?: ReadonlySet<string>
  /** [text] and [tag] are regular expressions (case insensitive, found anywhere in the line). [app] stays plain text. */
  regex?: boolean
  /** iOS: a bundle id in [app] also matches the process name by its last part (`com.example.MyApp` matches `MyApp`). Off elsewhere. */
  bundleIdLastPart?: boolean
}

const isBlank = (s: string): boolean => s.trim().length === 0

/** What the log viewer shows. */
export class LogFilter {
  readonly minLevel: LogLevel
  readonly text: string
  readonly tag: string
  readonly app: string
  readonly appPids?: ReadonlySet<string>
  readonly regex: boolean
  readonly bundleIdLastPart: boolean

  // Compiled once per filter, not per entry. An invalid pattern has no RegExp and is ignored until it is fixed.
  private readonly compiledText: Compiled
  private readonly compiledTag: Compiled

  constructor(o: LogFilterOptions = {}) {
    this.minLevel = o.minLevel ?? LogLevel.INFO
    this.text = o.text ?? ''
    this.tag = o.tag ?? ''
    this.app = o.app ?? ''
    this.appPids = o.appPids
    this.regex = o.regex ?? false
    this.bundleIdLastPart = o.bundleIdLastPart ?? false
    this.compiledText = this.compile(this.text)
    this.compiledTag = this.compile(this.tag)
  }

  private compile(source: string): Compiled {
    const trimmed = source.trim()
    if (!this.regex || trimmed.length === 0) return {}
    try {
      // Kotlin: CASE_INSENSITIVE or UNICODE_CASE. Not the `u` flag: it rejects escapes that Java accepts.
      return { pattern: new RegExp(trimmed, 'i') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Why the message pattern is invalid (undefined when it is fine, blank or regular expressions are off). */
  get textError(): string | undefined {
    return this.compiledText.error
  }

  /** Why the tag pattern is invalid (undefined when it is fine, blank or regular expressions are off). */
  get tagError(): string | undefined {
    return this.compiledTag.error
  }

  private textMatches(needle: string, compiled: Compiled, haystack: string): boolean {
    if (isBlank(needle)) return true
    if (!this.regex) return haystack.toLowerCase().includes(needle.trim().toLowerCase())
    if (!compiled.pattern) return true // invalid: ignored
    return compiled.pattern.test(haystack.slice(0, MAX_REGEX_INPUT))
  }

  matches(entry: LogEntry): boolean {
    if (entry.level < this.minLevel) return false
    if (!this.textMatches(this.tag, this.compiledTag, entry.tag)) return false
    if (!this.textMatches(this.text, this.compiledText, entry.message)) return false
    if (!isBlank(this.app)) {
      if (this.appPids !== undefined) {
        if (!this.appPids.has(entry.pid)) return false
      } else if (!this.appMatchesName(entry.tag)) {
        return false
      }
    }
    return true
  }

  /**
   * By name (iOS): the process name contains [app]; a bundle id such as `com.example.MyApp` also matches by its last part
   * (`MyApp`), because the log has the process name, not the bundle id.
   */
  private appMatchesName(name: string): boolean {
    const wanted = this.app.trim()
    const lower = name.toLowerCase()
    if (lower.includes(wanted.toLowerCase())) return true
    const last = wanted.slice(wanted.lastIndexOf('.') + 1)
    return this.bundleIdLastPart && wanted.includes('.') && last.length > 0 && lower.includes(last.toLowerCase())
  }

  /** The parts of [line] that the message filter matches (to highlight); empty without a message filter or with an invalid pattern. */
  matchRanges(line: string): IntRange[] {
    if (isBlank(this.text)) return []
    const ranges: IntRange[] = []
    if (this.regex) {
      const pattern = this.compiledText.pattern
      if (!pattern) return []
      const all = new RegExp(pattern.source, 'gi')
      for (const m of line.slice(0, MAX_REGEX_INPUT).matchAll(all)) {
        if (ranges.length >= MAX_RANGES) break
        if (m[0].length > 0) ranges.push({ first: m.index!, last: m.index! + m[0].length - 1 })
      }
    } else {
      const needle = this.text.trim().toLowerCase()
      const hay = line.toLowerCase()
      let from = 0
      while (ranges.length < MAX_RANGES) {
        const i = hay.indexOf(needle, from)
        if (i < 0) break
        ranges.push({ first: i, last: i + needle.length - 1 })
        from = i + needle.length
      }
    }
    return ranges
  }
}
