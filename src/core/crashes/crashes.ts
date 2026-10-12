// ported-from: core/crashes/Crashes.kt
import type { Device, Platform } from '../model'

/** One entry of `mobilecli device crashes list`. [timestamp] is `yyyy-MM-dd HH:mm:ss[.SSS]` in local time. */
export interface CrashEntry {
  id: string
  process: string
  timestamp: string
}

export const crashEntry = (id: string, process: string, timestamp: string): CrashEntry => ({ id, process, timestamp })

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A primitive member as a string (Gson `asString`), undefined when absent or not a primitive. */
function str(o: JsonObject, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
}

/** Gson `getAsJsonObject`: undefined when absent or null, throws when it is something else. */
function obj(o: JsonObject, key: string): JsonObject | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw new Error(`${key} is not an object`)
  return v
}

const lines = (s: string): string[] => s.split(/\r\n|\n|\r/)

const logcatPrefix = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]*:\s?/
const javaException = /^[\w.$]+(Exception|Error|Throwable)(: .*)?$/
const signalLine = /signal \d+ \((\w+)\), code (-?\d+) \(([\w_]+)\)(?:, fault addr (\S+))?/

/** Pure helpers for the crash report viewer. */
export const Crashes = {
  LIST_ARGS: ['device', 'crashes', 'list'],

  /** The id is one argument on purpose: Android ids contain colons, iOS ids contain spaces. */
  getArgs: (id: string): string[] => ['device', 'crashes', 'get', id],

  /** Entries of the `data` array, newest first (the platforms deliver oldest first or alphabetical). Undefined or malformed data gives an empty list. */
  parseList(data: unknown): CrashEntry[] {
    if (!Array.isArray(data)) return []
    const out: CrashEntry[] = []
    for (const e of data) {
      if (!isObject(e)) continue
      const id = str(e, 'id')
      if (id === undefined) continue
      out.push({ id, process: str(e, 'processName') ?? '', timestamp: str(e, 'timestamp') ?? '' })
    }
    return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
  },

  /** The report text of a `crashes get` result. */
  parseReport: (data: unknown): string | undefined => (isObject(data) ? str(data, 'content') : undefined),

  /** Case-insensitive match on process, id and time; blank matches everything. */
  filter(entries: CrashEntry[], text: string): CrashEntry[] {
    const q = text.trim().toLowerCase()
    if (q.length === 0) return entries
    return entries.filter((e) => e.process.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || e.timestamp.toLowerCase().includes(q))
  },

  /** A file name for saving: the id with characters that are invalid on common file systems replaced; `.ips` for iOS reports, else `.txt`. */
  fileName(entry: CrashEntry, platform: Platform): string {
    const replaced = entry.id.replace(/[:/\\*?"<>|]+/g, '-')
    const base = replaced.endsWith('.ips') ? replaced.slice(0, -4) : replaced
    return base + (platform === 'IOS' ? '.ips' : '.txt')
  },

  /** Shown above the list on iOS: mobilecli reads the Mac's crash folder, not the simulator's. */
  listNote: (device: Device): string | undefined => (device.platform === 'IOS' ? "Host crash reports (the Mac's DiagnosticReports), not only this simulator" : undefined),

  /** The one-line crash summary (exception type, signal or termination reason), or undefined when none can be found. */
  summary(platform: Platform, content: string): string | undefined {
    let result: string | undefined
    try {
      result = platform === 'IOS' ? iosSummary(content) : androidSummary(content)
    } catch {
      return undefined
    }
    return result !== undefined && result.trim().length > 0 ? result : undefined
  },

  /** The log lines without the logcat prefix (`date time pid tid L tag: `). */
  androidBody: (content: string): string[] => lines(content).map((l) => l.replace(logcatPrefix, '')),
}

function androidSummary(content: string): string | undefined {
  const all = Crashes.androidBody(content)
  const fatal = all.findIndex((l) => l.startsWith('FATAL EXCEPTION'))
  if (fatal >= 0) {
    const hit = all
      .slice(fatal + 1)
      .map((l) => l.trim())
      .find((l) => javaException.test(l))
    if (hit !== undefined) return hit
  }
  for (const line of all) {
    const m = signalLine.exec(line)
    if (!m) continue
    const sig = m[1]
    const code = m[3]
    const addr = m[4] ?? ''
    const abortLine = all.find((l) => l.startsWith('Abort message:'))
    const abort = abortLine?.slice('Abort message:'.length).trim().replace(/^'+|'+$/g, '')
    let out = `${sig} (${code})`
    if (addr.length > 0) out += ` fault addr ${addr}`
    if (abort) out += `: ${abort}`
    return out
  }
  const abortOnly = all.find((l) => l.startsWith('Abort message:'))
  if (abortOnly !== undefined) return abortOnly.trim()
  return all.find((l) => l.startsWith('Fatal signal'))?.trim()
}

/** An .ips file: line 1 is a header JSON, the rest one JSON document. Falls back to the header's app name. */
function iosSummary(content: string): string | undefined {
  const nl = content.indexOf('\n')
  const body = nl < 0 ? '' : content.slice(nl + 1)
  let root: JsonObject | undefined
  try {
    const parsed = JSON.parse(body)
    root = isObject(parsed) ? parsed : undefined
  } catch {
    root = undefined
  }
  if (root) {
    const ex = obj(root, 'exception')
    const term = obj(root, 'termination')
    const parts: string[] = []
    const type = ex ? str(ex, 'type') : undefined
    const signal = ex ? str(ex, 'signal') : undefined
    if (type !== undefined) parts.push(signal !== undefined ? `${type} (${signal})` : type)
    const subtype = ex ? str(ex, 'subtype') : undefined
    if (subtype !== undefined) parts.push(subtype)
    let reason = term ? str(term, 'indicator') : undefined
    if (reason === undefined && term) {
      const ns = str(term, 'namespace')
      const code = term.code === null || term.code === undefined ? undefined : typeof term.code === 'object' ? JSON.stringify(term.code) : String(term.code)
      const joined = [ns, code].filter((x): x is string => x !== undefined).join(' ')
      reason = joined.trim().length > 0 ? joined : undefined
    }
    if (reason !== undefined) parts.push(reason)
    const asiObj = obj(root, 'asi')
    if (asiObj) {
      for (const v of Object.values(asiObj)) {
        if (!Array.isArray(v)) continue
        const first = v[0]
        if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') {
          parts.push(String(first))
          break
        }
      }
    }
    if (parts.length > 0) return parts.join(' - ')
  }
  return undefined
}
