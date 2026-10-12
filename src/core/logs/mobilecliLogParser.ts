// ported-from: core/logs/MobilecliLogParser.kt
import { LogEntry, LogLevel } from './logs'

/**
 * Parses one line of `mobilecli device logs` (one JSON object per line). Used only where adb and simctl cannot serve a log
 * (a physical iPhone). Its own `--filter` is exact equality and is never used; all filtering stays in [LogFilter].
 * Android lines carry `tag`; iOS lines carry `process` (and optional `subsystem`/`category`). A multi line message is one entry.
 */
export const MobilecliLogParser = {
  time: /^\d{4}-(\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})?)\d*.*$/s,

  parse(line: string): LogEntry | undefined {
    if (!line.startsWith('{')) return undefined
    let o: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      o = parsed as Record<string, unknown>
    } catch {
      return undefined
    }
    const str = (key: string): string => {
      const v = o[key]
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
    }
    if (!('message' in o)) return undefined
    const stamp = str('timestamp')
    const t = this.time.exec(stamp)?.[1] ?? stamp
    const tag = str('tag') || str('process')
    return new LogEntry(t, level(str('level')), tag, str('pid'), str('message'))
  },
}

// Android: Verbose Debug Info Warning Error (Fatal/Assert not seen); iOS: Default Info Error Fault and "" (no metadata).
function level(word: string): LogLevel {
  switch (word.toLowerCase()) {
    case 'verbose':
      return LogLevel.VERBOSE
    case 'debug':
      return LogLevel.DEBUG
    case 'warning':
    case 'warn':
      return LogLevel.WARN
    case 'error':
      return LogLevel.ERROR
    case 'fatal':
    case 'fault':
    case 'assert':
      return LogLevel.FATAL
    default:
      return LogLevel.INFO // Info, Default, ""
  }
}
