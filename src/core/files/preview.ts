// ported-from: core/files/Preview.kt
import { parseXml, type XmlElement } from '../xml'
import { FileFormat } from './files'

/** What the preview pane shows for a file. */
export type Preview =
  /** Readable text; [format] is "text", "json" or "xml" (pretty printed). */
  | { readonly kind: 'Text'; readonly text: string; readonly format: string }
  /** Key/value style data (SharedPreferences, property lists). */
  | { readonly kind: 'Table'; readonly title: string; readonly columns: string[]; readonly rows: string[][] }
  /** Nothing to show, with the reason. */
  | { readonly kind: 'Message'; readonly text: string }
  /** A SQLite database: no viewer, the UI offers pulling it. */
  | { readonly kind: 'Sqlite'; readonly text: string }

export const Preview = {
  Text: (text: string, format: string): Preview => ({ kind: 'Text', text, format }),
  Table: (title: string, columns: string[], rows: string[][]): Preview => ({ kind: 'Table', title, columns, rows }),
  Message: (text: string): Preview => ({ kind: 'Message', text }),
  Sqlite: (text: string): Preview => ({ kind: 'Sqlite', text }),
}

type TablePreview = Extract<Preview, { kind: 'Table' }>

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const startsWith = (b: Uint8Array, prefix: Uint8Array): boolean => b.length >= prefix.length && prefix.every((v, i) => b[i] === v)
const ascii = (s: string): Uint8Array => Buffer.from(s, 'latin1')

/** Pure preview building: classifies a file by its bytes and name and formats it. */
export const FilePreview = {
  /** Previews read at most this much; larger files say "use Download". */
  MAX_BYTES: 256 * 1024,

  /** [bytes] is the start of the file (at most [MAX_BYTES] + 1 of it), [totalSize] the size from the listing (undefined: unknown). */
  build(name: string, bytes: Uint8Array, totalSize: number | undefined): Preview {
    const max = FilePreview.MAX_BYTES
    if (startsWith(bytes, SQLITE_MAGIC)) return Preview.Sqlite(`SQLite database (${FileFormat.size(totalSize ?? bytes.length)}). There is no viewer here.`)
    if ((totalSize ?? bytes.length) > max || bytes.length > max)
      return Preview.Message(`Too large to preview (${FileFormat.size(totalSize ?? bytes.length)}, the limit is ${FileFormat.size(max)}). Use Download.`)
    if (bytes.length === 0) return Preview.Message('Empty file')
    if (startsWith(bytes, ascii('bplist00'))) {
      try {
        return plistTable(PlistParser.parseBinary(Buffer.from(bytes)), name)
      } catch (e) {
        return Preview.Message(`Unreadable binary property list (${errorText(e)}). Use Download.`)
      }
    }
    const text = FilePreview.decodeUtf8(bytes)
    if (text === undefined) return Preview.Message(`Binary file (${FileFormat.size(bytes.length)}). Use Download.`)
    // eslint-disable-next-line no-irregular-whitespace -- the class holds a literal BOM
    const trimmed = text.replace(/^﻿+/, '').trim()
    if (trimmed.startsWith('<')) {
      const p = xml(name, trimmed)
      if (p) return p
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const p = json(trimmed)
      if (p) return p
    }
    return Preview.Text(text, 'text')
  },

  /** The text when [bytes] are valid UTF-8 without NUL bytes in the first 8 KB, else undefined. */
  decodeUtf8(bytes: Uint8Array): string | undefined {
    for (let i = 0; i < Math.min(bytes.length, 8192); i++) if (bytes[i] === 0) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return undefined
    }
  },
}

const SQLITE_MAGIC = ascii('SQLite format 3\u0000')

function json(text: string): Preview | undefined {
  try {
    // Gson pretty printing is 2 spaces and no HTML escaping, like JSON.stringify.
    return Preview.Text(JSON.stringify(JSON.parse(text), null, 2), 'json')
  } catch {
    return undefined
  }
}

/**
 * Parses [text] as XML. DOCTYPE is rejected by `core/xml` (no entity tricks), except the plain form Apple property lists carry
 * (`<!DOCTYPE plist PUBLIC "..." "http://...">`, no internal subset), which is dropped without ever being fetched.
 */
function parseSafe(text: string): XmlElement | undefined {
  try {
    return parseXml(text.replace(/<!DOCTYPE[^>[]*>/i, ''))
  } catch {
    return undefined
  }
}

function xml(name: string, text: string): Preview | undefined {
  const root = parseSafe(text)
  if (!root) return undefined
  if (root.tagName === 'plist') {
    try {
      return plistTable(PlistParser.parseXml(root), name)
    } catch (e) {
      return Preview.Message(`Unreadable property list (${errorText(e)})`)
    }
  }
  if (root.tagName === 'map') {
    const t = SharedPrefs.table(root)
    if (t) return t
  }
  return Preview.Text(prettyXml(root), 'xml')
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

/**
 * Like the Java Transformer with indent 2 and no declaration. Whitespace only text between elements is dropped. Differs: comments are not
 * kept (core/xml skips them), and text mixed with child elements is printed on its own line before the children.
 */
function prettyXml(root: XmlElement): string {
  const lines: string[] = []
  const walk = (e: XmlElement, depth: number) => {
    const ind = '  '.repeat(depth)
    const attrs = Object.entries(e.attributes).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
    if (e.children.length === 0) {
      lines.push(e.text === '' ? `${ind}<${e.tagName}${attrs}/>` : `${ind}<${e.tagName}${attrs}>${escapeText(e.text)}</${e.tagName}>`)
      return
    }
    lines.push(`${ind}<${e.tagName}${attrs}>`)
    if (e.text.trim() !== '') lines.push(`${ind}  ${escapeText(e.text.trim())}`)
    for (const c of e.children) walk(c, depth + 1)
    lines.push(`${ind}</${e.tagName}>`)
  }
  walk(root, 0)
  return lines.join('\n')
}

/** DOM `textContent`: the text of the element and all its descendants. */
const textContent = (e: XmlElement): string => e.text + e.children.map(textContent).join('')

function plistTable(value: PlistValue, name: string): TablePreview {
  return Preview.Table(`Property list ${name}`, ['Key', 'Type', 'Value'], PlistFlatten.rows(value)) as TablePreview
}

const TYPES = new Set(['string', 'int', 'long', 'float', 'double', 'boolean', 'set'])

/** Android SharedPreferences: `<map>` with typed children. */
export const SharedPrefs = {
  /** A Key / Type / Value table, or undefined when [map] does not look like SharedPreferences (no or untyped children). */
  table(map: XmlElement): TablePreview | undefined {
    const rows: string[][] = []
    for (const c of map.children) {
      if (!TYPES.has(c.tagName)) return undefined
      const key = c.attributes.name ?? ''
      if (c.tagName === 'string') rows.push([key, 'string', textContent(c)])
      else if (c.tagName === 'set') rows.push([key, 'set', '[' + c.children.filter((s) => s.tagName === 'string').map(textContent).join(', ') + ']'])
      else rows.push([key, c.tagName, c.attributes.value ?? ''])
    }
    return Preview.Table(`SharedPreferences (${rows.length} entries)`, ['Key', 'Type', 'Value'], rows) as TablePreview
  },
}

/** A property list value. */
export type PlistValue =
  | { readonly kind: 'Dict'; readonly entries: Array<[string, PlistValue]> }
  | { readonly kind: 'Arr'; readonly items: PlistValue[]; readonly isSet: boolean }
  | { readonly kind: 'Str'; readonly value: string }
  | { readonly kind: 'Int'; readonly value: bigint }
  | { readonly kind: 'Real'; readonly value: number }
  | { readonly kind: 'Bool'; readonly value: boolean }
  /** ISO-8601 UTC text. */
  | { readonly kind: 'Date'; readonly iso: string }
  | { readonly kind: 'Data'; readonly bytes: Buffer }
  | { readonly kind: 'Uid'; readonly value: bigint }
  | { readonly kind: 'Null' }

export const PlistValue = {
  Dict: (entries: Array<[string, PlistValue]>): PlistValue => ({ kind: 'Dict', entries }),
  Arr: (items: PlistValue[], isSet = false): PlistValue => ({ kind: 'Arr', items, isSet }),
  Str: (value: string): PlistValue => ({ kind: 'Str', value }),
  Int: (value: bigint): PlistValue => ({ kind: 'Int', value }),
  Real: (value: number): PlistValue => ({ kind: 'Real', value }),
  Bool: (value: boolean): PlistValue => ({ kind: 'Bool', value }),
  Date: (iso: string): PlistValue => ({ kind: 'Date', iso }),
  Data: (bytes: Buffer): PlistValue => ({ kind: 'Data', bytes }),
  Uid: (value: bigint): PlistValue => ({ kind: 'Uid', value }),
  Null: { kind: 'Null' } as PlistValue,
}

export class PlistException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlistException'
  }
}

/**
 * Plain decimal text (no exponent), like plutil shows it. Reproduces Java's `BigDecimal(Double.toString(d)).toPlainString()`: whole numbers
 * print as "3.0", numbers from 1e7 up print without a fraction, tiny ones keep a trailing zero ("0.00010").
 */
function realText(d: number): string {
  if (Number.isNaN(d)) return 'NaN'
  if (!Number.isFinite(d)) return d < 0 ? '-Infinity' : 'Infinity'
  if (d === 0) return '0.0'
  const sign = d < 0 ? '-' : ''
  const a = Math.abs(d)
  const [mant, exp] = a.toExponential().split('e')
  const ds = mant.replace('.', '')
  const e = Number(exp)
  if (a >= 1e-3 && a < 1e7) {
    const int = e >= 0 ? ds.slice(0, e + 1).padEnd(e + 1, '0') : '0'
    const frac = e >= 0 ? ds.slice(e + 1) || '0' : '0'.repeat(-e - 1) + ds
    return `${sign}${int}.${frac}`
  }
  const frac = ds.slice(1) || '0'
  const digits = ds[0] + frac
  const scale = frac.length - e
  if (scale <= 0) return sign + digits + '0'.repeat(-scale)
  if (scale >= digits.length) return `${sign}0.${'0'.repeat(scale - digits.length)}${digits}`
  return `${sign}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
}

const hex = (b: Buffer) => [...b.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** Flattens a [PlistValue] into Key / Type / Value rows; nested keys are shown as `a.b` and `a[0]`. */
export const PlistFlatten = {
  rows(root: PlistValue): string[][] {
    const out: string[][] = []
    const walk = (key: string, v: PlistValue): void => {
      switch (v.kind) {
        case 'Dict':
          if (key !== '') out.push([key, 'dict', `${v.entries.length} items`])
          for (const [k, c] of v.entries) walk(key === '' ? k : `${key}.${k}`, c)
          break
        case 'Arr':
          if (key !== '') out.push([key, v.isSet ? 'set' : 'array', `${v.items.length} items`])
          v.items.forEach((c, i) => walk(`${key}[${i}]`, c))
          break
        case 'Str':
          out.push([key, 'string', v.value])
          break
        case 'Int':
          out.push([key, 'integer', v.value.toString()])
          break
        case 'Real':
          out.push([key, 'real', realText(v.value)])
          break
        case 'Bool':
          out.push([key, 'bool', String(v.value)])
          break
        case 'Date':
          out.push([key, 'date', v.iso])
          break
        case 'Data':
          out.push([key, 'data', `${v.bytes.length} bytes: ${hex(v.bytes)}${v.bytes.length > 16 ? '...' : ''}`])
          break
        case 'Uid':
          out.push([key, 'uid', v.value.toString()])
          break
        case 'Null':
          out.push([key, 'null', ''])
          break
      }
    }
    walk('', root)
    return out
  },
}

const MAX_DEPTH = 64
const MAX_NODES = 100_000

const toDouble = (s: string): number | undefined => {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isNaN(n) && t !== 'NaN' ? undefined : n
}

export const PlistParser = {
  /** An XML property list: [plist] is its `<plist>` element. */
  parseXml(plist: XmlElement): PlistValue {
    const first = plist.children[0]
    if (!first) throw new PlistException('empty plist')
    return xmlValue(first, 0)
  },

  /** A `bplist00` file. Throws [PlistException] for anything malformed (offsets are bounds checked, nesting is limited). */
  parseBinary(b: Buffer): PlistValue {
    if (b.length < 40) throw new PlistException('too short')
    const t = b.length - 32
    const offsetSize = u(b, t + 6, 1)
    const refSize = u(b, t + 7, 1)
    const count = u(b, t + 8, 8)
    const top = u(b, t + 16, 8)
    const tableAt = u(b, t + 24, 8)
    if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new PlistException('bad trailer')
    if (count <= 0 || count > b.length || top >= count || tableAt + count * offsetSize > t) throw new PlistException('bad trailer')
    const offsets: number[] = []
    for (let i = 0; i < count; i++) offsets.push(u(b, tableAt + i * offsetSize, offsetSize))
    return new BinaryReader(b, offsets, refSize).read(top, 0)
  },
}

function xmlValue(e: XmlElement, depth: number): PlistValue {
  if (depth > MAX_DEPTH) throw new PlistException('nested too deeply')
  switch (e.tagName) {
    case 'dict': {
      const kids = e.children
      const entries: Array<[string, PlistValue]> = []
      let i = 0
      while (i < kids.length) {
        if (kids[i].tagName !== 'key' || i + 1 >= kids.length) throw new PlistException('dict without key/value pairs')
        entries.push([textContent(kids[i]), xmlValue(kids[i + 1], depth + 1)])
        i += 2
      }
      return PlistValue.Dict(entries)
    }
    case 'array':
      return PlistValue.Arr(e.children.map((c) => xmlValue(c, depth + 1)))
    case 'string':
      return PlistValue.Str(textContent(e))
    case 'integer': {
      const t = textContent(e).trim()
      if (!/^[+-]?\d+$/.test(t)) throw new PlistException('bad integer')
      return PlistValue.Int(BigInt(t))
    }
    case 'real': {
      const d = toDouble(textContent(e))
      if (d === undefined) throw new PlistException('bad real')
      return PlistValue.Real(d)
    }
    case 'true':
      return PlistValue.Bool(true)
    case 'false':
      return PlistValue.Bool(false)
    case 'date':
      return PlistValue.Date(textContent(e).trim())
    case 'data':
      return PlistValue.Data(Buffer.from(textContent(e).trim(), 'base64'))
    default:
      throw new PlistException(`unknown element <${e.tagName}>`)
  }
}

/** Big endian unsigned value of [n] bytes at [at] as a signed 64 bit like Kotlin's Long (huge values lose precision, only used for bounds). */
function u(b: Buffer, at: number, n: number): number {
  if (at < 0 || at + n > b.length || !Number.isFinite(at)) throw new PlistException('read outside the file')
  return Number(uBig(b, at, n, true))
}

function uBig(b: Buffer, at: number, n: number, signed64: boolean): bigint {
  if (at < 0 || at + n > b.length) throw new PlistException('read outside the file')
  let v = 0n
  for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[at + i])
  return signed64 && n === 8 ? BigInt.asIntN(64, v) : v
}

class BinaryReader {
  /** Objects can be referenced many times, so depth alone does not bound the work: cap the total as well. */
  private visited = 0

  constructor(
    private readonly b: Buffer,
    private readonly offsets: number[],
    private readonly refSize: number,
  ) {}

  read(index: number, depth: number): PlistValue {
    if (depth > MAX_DEPTH) throw new PlistException('nested too deeply')
    if (++this.visited > MAX_NODES) throw new PlistException('too many objects')
    if (index < 0 || index >= this.offsets.length) throw new PlistException('bad object reference')
    const b = this.b
    const at = this.offsets[index]
    if (at < 8 || at >= b.length) throw new PlistException('bad object offset')
    const marker = b[at]
    const hi = marker >> 4
    const lo = marker & 0xf
    switch (hi) {
      case 0x0:
        if (lo === 0x8) return PlistValue.Bool(false)
        if (lo === 0x9) return PlistValue.Bool(true)
        if (lo === 0x0) return PlistValue.Null
        throw new PlistException('unknown marker')
      case 0x1: {
        const n = 1 << lo
        if (n > 16) throw new PlistException('bad integer size')
        return PlistValue.Int(n === 16 ? uBig(b, at + 1, 16, false) : uBig(b, at + 1, n, true))
      }
      case 0x2: {
        if (lo === 2) return PlistValue.Real(this.bytes(at + 1, 4).readFloatBE(0))
        if (lo === 3) return PlistValue.Real(this.bytes(at + 1, 8).readDoubleBE(0))
        throw new PlistException('bad real size')
      }
      case 0x3: {
        const seconds = this.bytes(at + 1, 8).readDoubleBE(0)
        const ms = 978307200000 + Math.trunc(seconds * 1000)
        if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new PlistException('bad date')
        return PlistValue.Date(new Date(ms).toISOString().replace('.000Z', 'Z'))
      }
      case 0x4: {
        const [n, s] = this.length(at, lo)
        return PlistValue.Data(this.bytes(s, n))
      }
      case 0x5: {
        const [n, s] = this.length(at, lo)
        return PlistValue.Str(this.bytes(s, n).toString('latin1'))
      }
      case 0x6: {
        const [n, s] = this.length(at, lo)
        const raw = Buffer.from(this.bytes(s, n * 2)) // swap to little endian for the decoder
        raw.swap16()
        return PlistValue.Str(raw.toString('utf16le'))
      }
      case 0x8:
        return PlistValue.Uid(uBig(b, at + 1, lo + 1, false))
      case 0xa:
      case 0xc: {
        const [n, s] = this.length(at, lo)
        const items: PlistValue[] = []
        for (let i = 0; i < n; i++) items.push(this.read(this.ref(s, i), depth + 1))
        return PlistValue.Arr(items, hi === 0xc)
      }
      case 0xd: {
        const [n, s] = this.length(at, lo)
        const entries: Array<[string, PlistValue]> = []
        for (let i = 0; i < n; i++) {
          const key = this.read(this.ref(s, i), depth + 1)
          if (key.kind !== 'Str') throw new PlistException('non string dictionary key')
          entries.push([key.value, this.read(this.ref(s, n + i), depth + 1)])
        }
        return PlistValue.Dict(entries)
      }
      default:
        throw new PlistException(`unknown marker 0x${marker.toString(16).padStart(2, '0')}`)
    }
  }

  private ref(start: number, i: number): number {
    return u(this.b, start + i * this.refSize, this.refSize)
  }

  private bytes(at: number, n: number): Buffer {
    if (n < 0 || at < 0 || at + n > this.b.length) throw new PlistException('read outside the file')
    return this.b.subarray(at, at + n)
  }

  /** The element count of a marker at [at] and where its payload starts. */
  private length(at: number, lo: number): [number, number] {
    if (lo !== 0xf) return [lo, at + 1]
    if (at + 1 >= this.b.length) throw new PlistException('bad length')
    const intMarker = this.b[at + 1]
    if (intMarker >> 4 !== 1) throw new PlistException('bad length')
    const n = 1 << (intMarker & 0xf)
    if (n > 8) throw new PlistException('bad length')
    const len = u(this.b, at + 2, n)
    if (len < 0 || len > this.b.length) throw new PlistException('bad length')
    return [len, at + 2 + n]
  }
}
