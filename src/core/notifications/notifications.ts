// ported-from: core/notifications/Notifications.kt
// Split from the Kotlin file: the runner backed classes (IosNotifications, AndroidNotifications) live in notificationBackends.ts
// because they need node:fs; this file stays usable in the webview. Quirk: Gson keeps the text of numbers in custom data
// (`1.0` stays `1.0`), JSON.parse does not (`1`), so such custom numbers are rewritten.

/** The fields of the iOS form. Blank strings are left out of the payload. */
export interface ApnsForm {
  title: string
  subtitle: string
  body: string
  badge: string
  sound: string
  category: string
  /** An optional JSON object whose keys are added next to `aps`. */
  customJson: string
}

export const apnsForm = (f: Partial<ApnsForm> = {}): ApnsForm => ({ title: '', subtitle: '', body: '', badge: '', sound: '', category: '', customJson: '', ...f })

const isBlank = (s: string): boolean => s.trim().length === 0
const lines = (s: string): string[] => s.split(/\r\n|\n|\r/)

/**
 * A payload ready to show: [pretty] for the preview, [compact] is what is sent (exactly these UTF-8 bytes), [size] its byte count.
 * [problem] is set when the payload cannot be sent at all; [oversize] when it is above the 4096 byte APNs limit (simctl then refuses it).
 */
export class ApnsPayload {
  constructor(
    readonly pretty: string,
    readonly compact: string,
    readonly size: number,
    readonly problem: string | undefined,
  ) {}

  get oversize(): boolean {
    return this.size > ApnsPayloads.LIMIT
  }

  get sendable(): boolean {
    return this.problem === undefined
  }
}

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Kotlin `toIntOrNull`. */
function toIntOrNull(text: string): number | undefined {
  if (!/^[+-]?\d+$/.test(text)) return undefined
  const n = Number(text)
  return n >= -2147483648 && n <= 2147483647 ? n : undefined
}

const firstLine = (message: string | undefined): string => lines(message ?? 'parse error')[0]

export const ApnsPayloads = {
  /** The inclusive limit simctl enforces on the raw bytes it is given (verified: 4096 bytes sent, 4097 refused). */
  LIMIT: 4096,

  byteSize: (text: string): number => new TextEncoder().encode(text).length,

  /** Builds `{"aps":{"alert":{...},"badge":..,"sound":..,"category":..}, ...custom}` from the form. */
  build(form: ApnsForm): ApnsPayload {
    const root: JsonObject = {}
    const aps: JsonObject = {}
    const alert: JsonObject = {}
    if (!isBlank(form.title)) alert.title = form.title
    if (!isBlank(form.subtitle)) alert.subtitle = form.subtitle
    if (!isBlank(form.body)) alert.body = form.body
    if (Object.keys(alert).length > 0) aps.alert = alert
    let problem: string | undefined
    const badge = form.badge.trim()
    if (badge.length > 0) {
      const n = toIntOrNull(badge)
      if (n === undefined || n < 0) problem = 'Badge must be a whole number of 0 or more'
      else aps.badge = n
    }
    if (!isBlank(form.sound)) aps.sound = form.sound.trim()
    if (!isBlank(form.category)) aps.category = form.category.trim()
    root.aps = aps
    if (!isBlank(form.customJson)) {
      try {
        const custom: unknown = JSON.parse(form.customJson)
        if (!isObject(custom)) problem = problem ?? 'Custom data must be a JSON object'
        else {
          for (const [k, v] of Object.entries(custom)) {
            if (k === 'aps') problem = problem ?? 'Custom data must not contain "aps" (use the fields above)'
            else root[k] = v
          }
        }
      } catch (e) {
        problem = problem ?? `Custom data is not valid JSON: ${firstLine(e instanceof Error ? e.message : undefined)}`
      }
    }
    if (problem === undefined && Object.keys(aps).length === 0) problem = 'Fill in at least one of title, subtitle, body, badge, sound or category (an empty aps is refused by the simulator)'
    return render(root, problem)
  },

  /** Validates a hand written payload and renders it. Invalid JSON gives the text back unchanged with a [ApnsPayload.problem]. */
  inspect(raw: string): ApnsPayload {
    if (isBlank(raw)) return new ApnsPayload(raw, raw, ApnsPayloads.byteSize(raw), 'The payload must be a JSON object')
    let element: unknown
    try {
      element = JSON.parse(raw)
    } catch (e) {
      return new ApnsPayload(raw, raw, ApnsPayloads.byteSize(raw), `Not valid JSON: ${firstLine(e instanceof Error ? e.message : undefined)}`)
    }
    if (!isObject(element)) return new ApnsPayload(raw, raw, ApnsPayloads.byteSize(raw), 'The payload must be a JSON object')
    const aps = element.aps
    let problem: string | undefined
    if (!('aps' in element)) problem = 'The payload has no "aps" key'
    else if (!isObject(aps)) problem = '"aps" must be an object'
    else if (Object.keys(aps).length === 0) problem = '"aps" is empty (the simulator refuses it)'
    else if ('badge' in aps && typeof aps.badge !== 'number') problem = '"badge" must be a number'
    return render(element, problem)
  },
}

function render(root: JsonObject, problem: string | undefined): ApnsPayload {
  const c = JSON.stringify(root)
  return new ApnsPayload(JSON.stringify(root, null, 2), c, ApnsPayloads.byteSize(c), problem)
}

/** What a send did: the exact text of the tool, [error] when it failed. */
export interface NotificationResult {
  text: string
  error: boolean
}

export const notificationResult = (text: string, error: boolean): NotificationResult => ({ text, error })

/** The Android notification styles of `cmd notification post -S`. */
export interface PostStyle {
  readonly name: string
  readonly label: string
  readonly arg: string | undefined
}

export const PostStyles = {
  PLAIN: { name: 'PLAIN', label: 'Plain', arg: undefined } as PostStyle,
  BIGTEXT: { name: 'BIGTEXT', label: 'Big text', arg: 'bigtext' } as PostStyle,
  INBOX: { name: 'INBOX', label: 'Inbox', arg: 'inbox' } as PostStyle,
  MESSAGING: { name: 'MESSAGING', label: 'Messaging', arg: 'messaging' } as PostStyle,
}

/** All styles in declaration order. */
export const postStyles = (): PostStyle[] => Object.values(PostStyles)

export interface AndroidPost {
  title: string
  text: string
  style: PostStyle
  tag: string
  /** Inbox style: one line per entry. */
  lines: string[]
  /** Messaging style: the conversation title and `who:text` messages. */
  conversation: string
  messages: string[]
}

export const androidPost = (p: Partial<AndroidPost> = {}): AndroidPost => ({
  title: '',
  text: '',
  style: PostStyles.PLAIN,
  tag: 'mobiletestbench',
  lines: [],
  conversation: '',
  messages: [],
  ...p,
})

export interface IntentSpec {
  action: string
  pkg: string
  component: string
  /** One `[type:]key=value` per line, see [NotificationCommands.parseExtras]. */
  extras: string
}

export const intentSpec = (i: Partial<IntentSpec> = {}): IntentSpec => ({ action: '', pkg: '', component: '', extras: '', ...i })

/** A parsed extra: [flag] is the `am` option (`--es`, `--ei`, ...). */
export interface IntentExtra {
  flag: string
  key: string
  value: string
}

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TYPES: Record<string, string> = { s: '--es', i: '--ei', z: '--ez', l: '--el', f: '--ef' }

const toLongOrNull = (v: string): bigint | undefined => {
  if (!/^[+-]?\d+$/.test(v)) return undefined
  const n = BigInt(v)
  return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n ? n : undefined
}
const toFloatOrNull = (v: string): number | undefined => {
  if (!/^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?)$/.test(v)) return undefined
  return Number.parseFloat(v)
}

export const NotificationCommands = {
  /** Quotes [s] for a POSIX shell with single quotes (` ' ` becomes `'\''`). adb joins its arguments and the device shell parses them again, so every user value needs this. */
  shellQuote: (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'",

  /** `xcrun simctl push <udid> <bundle> <file>`. */
  iosPush: (xcrun: string, udid: string, bundleId: string, file: string): string[] => [xcrun, 'simctl', 'push', udid, bundleId, file],

  validBundleId: (id: string): boolean => BUNDLE.test(id),

  /** `adb -s <serial> shell "<command>"`: the command stays ONE argument. */
  adbShell: (adb: string, serial: string, command: string): string[] => [adb, '-s', serial, 'shell', command],

  /** A problem with the post (undefined when fine). Newlines cannot be passed on one command line reliably, so they are refused. */
  postProblem(p: AndroidPost): string | undefined {
    const single: Array<[string, string]> = [
      ['Title', p.title],
      ['Text', p.text],
      ['Tag', p.tag],
      ['Conversation', p.conversation],
      ...p.lines.map((l): [string, string] => ['Inbox line', l]),
      ...p.messages.map((m): [string, string] => ['Message', m]),
    ]
    const bad = single.find(([, v]) => v.includes('\n') || v.includes('\r'))
    if (bad) return `${bad[0]} must be a single line`
    if (isBlank(p.tag)) return 'Tag is required (posting again with the same tag replaces the notification)'
    if (isBlank(p.text)) return 'Text is required'
    if (p.style === PostStyles.INBOX && p.lines.every(isBlank)) return 'Inbox style needs at least one line'
    if (p.style === PostStyles.MESSAGING) {
      if (isBlank(p.conversation)) return 'Messaging style needs a conversation title'
      const msgs = p.messages.filter((m) => !isBlank(m))
      if (msgs.length === 0) return 'Messaging style needs at least one who:text message'
      const badMsg = msgs.find((m) => !m.includes(':') || isBlank(m.slice(0, m.indexOf(':'))))
      if (badMsg !== undefined) return `Message "${badMsg}" must look like who:text`
    }
    return undefined
  },

  /** The remote command string of the post. Order as verified on the device: style and its arguments, then -t, tag, text. */
  androidPost(p: AndroidPost): string {
    const q = NotificationCommands.shellQuote
    let s = 'cmd notification post'
    if (p.style === PostStyles.BIGTEXT) s += ' -S bigtext'
    else if (p.style === PostStyles.INBOX) {
      s += ' -S inbox'
      for (const l of p.lines.filter((x) => !isBlank(x))) s += ' --line ' + q(l)
    } else if (p.style === PostStyles.MESSAGING) {
      s += ' -S messaging --conversation ' + q(p.conversation)
      for (const m of p.messages.filter((x) => !isBlank(x))) s += ' --message ' + q(m)
    }
    if (!isBlank(p.title)) s += ' -t ' + q(p.title)
    return s + ' ' + q(p.tag) + ' ' + q(p.text)
  },

  CLEAR_SHELL: 'service call notification 1 s16 com.android.shell i32 0',
  LIST: 'cmd notification list',

  /** Entries of `cmd notification list` (`user|package|id|tag|uid`) posted by the shell. */
  shellNotificationCount: (listOutput: string): number => lines(listOutput).filter((l) => l.split('|')[1] === 'com.android.shell').length,

  /** Parses extras: one `[s:|i:|z:|l:|f:]key=value` per line; blank lines and lines starting with `#` are skipped. Returns the extras or the first error. */
  parseExtras(text: string): [IntentExtra[], string | undefined] {
    const out: IntentExtra[] = []
    const all = lines(text)
    for (let i = 0; i < all.length; i++) {
      const line = all[i].trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) return [out, `Extras line ${i + 1} must look like key=value`]
      let key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1)
      let type = 's'
      const colon = key.indexOf(':')
      if (colon === 1 && key[0] in TYPES) {
        type = key[0]
        key = key.slice(2).trim()
      }
      if (key.length === 0 || /\s/.test(key)) return [out, `Extras line ${i + 1}: the key must not be empty or contain spaces`]
      const v = value.trim()
      if (type === 'i' && toIntOrNull(v) === undefined) return [out, `Extras line ${i + 1}: "${value}" is not an int`]
      if (type === 'l' && toLongOrNull(v) === undefined) return [out, `Extras line ${i + 1}: "${value}" is not a long`]
      if (type === 'f' && toFloatOrNull(v) === undefined) return [out, `Extras line ${i + 1}: "${value}" is not a float`]
      if (type === 'z' && v !== 'true' && v !== 'false') return [out, `Extras line ${i + 1}: a boolean must be true or false`]
      out.push({ flag: TYPES[type], key, value: type === 's' ? value : v })
    }
    return [out, undefined]
  },

  broadcastProblem(i: IntentSpec): string | undefined {
    if (isBlank(i.action) && isBlank(i.component)) return 'Give an action or a component (am broadcast needs an intent)'
    const spaced = (
      [
        ['Action', i.action],
        ['Package', i.pkg],
        ['Component', i.component],
      ] as Array<[string, string]>
    ).find(([, v]) => /\s/.test(v))
    if (spaced) return `${spaced[0]} must not contain spaces`
    if (!isBlank(i.component) && !i.component.includes('/')) return 'Component must look like package/.Class'
    return NotificationCommands.parseExtras(i.extras)[1]
  },

  /** The remote command string of the broadcast. Call [broadcastProblem] first. */
  androidBroadcast(i: IntentSpec): string {
    const q = NotificationCommands.shellQuote
    let s = 'am broadcast'
    if (!isBlank(i.action)) s += ' -a ' + q(i.action.trim())
    if (!isBlank(i.component)) s += ' -n ' + q(i.component.trim())
    else if (!isBlank(i.pkg)) s += ' -p ' + q(i.pkg.trim())
    for (const e of NotificationCommands.parseExtras(i.extras)[0]) s += ` ${e.flag} ${q(e.key)} ${q(e.value)}`
    return s
  },

  /** simctl: success is exit 0 AND "Notification sent to ..." on stdout (invalid JSON exits 0 with an error on stderr). */
  interpretIosPush(exit: number, stdout: string, stderr: string): NotificationResult {
    const out = stdout.trim()
    if (exit === 0 && out.startsWith('Notification sent to')) return { text: lines(out)[0], error: false }
    const text = stderr.trim() || out || `simctl push failed with exit code ${exit} and no output`
    return { text, error: true }
  },

  /** `cmd notification post` prints "posting for user N:"; failures print "Error occurred..." or "Unknown command". */
  interpretAndroidPost(exit: number, stdout: string, stderr: string): NotificationResult {
    const text = stdout.trim() || stderr.trim()
    const failed = exit !== 0 || text.includes('Error occurred') || text.startsWith('Unknown command') || text.startsWith('Exception')
    return { text: text || `No output (exit code ${exit})`, error: failed }
  },

  /** `am broadcast` ends with "Broadcast completed: result=N"; errors are a Java stack trace on stdout. */
  interpretBroadcast(exit: number, stdout: string, stderr: string): NotificationResult {
    const text = stdout.trim() || stderr.trim()
    const all = lines(text)
    const completed = all.some((l) => l.startsWith('Broadcast completed'))
    if (exit === 0 && completed) return { text: all.filter((l) => !isBlank(l)).join(' | '), error: false }
    const nonBlank = all.filter((l) => !isBlank(l))
    const exceptionLine = nonBlank.find((l) => l.startsWith('java.') || l.startsWith('android.'))
    const msg = nonBlank[0]?.startsWith('Exception occurred') && exceptionLine !== undefined ? exceptionLine : nonBlank.slice(0, 3).join(' | ')
    return { text: msg || `No output (exit code ${exit})`, error: true }
  },
}

/** One remembered send: [kind] is "ios", "post" or "intent", [fields] what is needed to refill the form. */
export interface HistoryEntry {
  kind: string
  fields: Record<string, string>
}

export const historyEntry = (kind: string, fields: Record<string, string>): HistoryEntry => ({ kind, fields })

/** Equality of two entries (the Kotlin data class `==`). */
export function sameEntry(a: HistoryEntry, b: HistoryEntry): boolean {
  const ka = Object.keys(a.fields)
  const kb = Object.keys(b.fields)
  return a.kind === b.kind && ka.length === kb.length && ka.every((k) => a.fields[k] === b.fields[k])
}

/** A one-line description for the combo. */
export function historyLabel(e: HistoryEntry): string {
  const f = e.fields
  let s: string
  if (e.kind === 'ios') {
    const payload = f.payload ?? ''
    let shown = payload
    try {
      shown = ApnsPayloads.inspect(payload).compact
    } catch {
      // keep the raw text
    }
    s = `iOS ${f.bundle ?? ''}: ${shown}`
  } else if (e.kind === 'post') s = `Post ${f.tag ?? ''}: ${f.title ?? ''} ${f.text ?? ''}`.trim()
  else s = `Intent ${isBlank(f.action ?? '') ? (f.component ?? '') : f.action}`
  return s.slice(0, 100)
}

/** The last [MAX] sends, newest first, without duplicates, stored as one JSON string per entry. */
export const PayloadHistory = {
  MAX: 15,

  add: (list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] => [entry, ...list.filter((e) => !sameEntry(e, entry))].slice(0, PayloadHistory.MAX),

  serialize(e: HistoryEntry): string {
    const fields: Record<string, string> = {}
    for (const k of Object.keys(e.fields).sort()) fields[k] = e.fields[k]
    return JSON.stringify({ kind: e.kind, fields })
  },

  /** Undefined for a line that is not a valid entry (it is dropped when loading). */
  parse(s: string): HistoryEntry | undefined {
    try {
      const o: unknown = JSON.parse(s)
      if (!isObject(o) || typeof o.kind !== 'string' || !isObject(o.fields)) return undefined
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(o.fields)) {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined
        fields[k] = String(v)
      }
      return { kind: o.kind, fields }
    } catch {
      return undefined
    }
  },

  load: (list: string[]): HistoryEntry[] =>
    list
      .map((l) => PayloadHistory.parse(l))
      .filter((e): e is HistoryEntry => e !== undefined)
      .slice(0, PayloadHistory.MAX),

  save: (list: HistoryEntry[]): string[] => list.slice(0, PayloadHistory.MAX).map((e) => PayloadHistory.serialize(e)),
}
