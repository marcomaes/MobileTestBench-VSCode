// ported-from: test:core/FilePreviewTest.kt
import { describe, expect, it } from 'vitest'
import { FilePreview, PlistException, PlistFlatten, PlistParser, PlistValue, Preview } from '../../src/core/files/preview'
import { fixtureBytes } from '../helpers/fixtures'

const preview = (name: string, fixtureName: string): Preview => FilePreview.build(name, fixtureBytes(fixtureName), fixtureBytes(fixtureName).length)
const table = (p: Preview) => {
  if (p.kind !== 'Table') throw new Error(`expected a table, got ${p.kind}`)
  return p
}
const rows = (p: Preview) => table(p).rows
const byKey = (r: string[][]) => new Map(r.map((x) => [x[0], x]))
const get = (m: Map<string, string[]>, k: string) => {
  const v = m.get(k)
  if (!v) throw new Error(`no row ${k}`)
  return v
}
const sortedByKey = (r: string[][]) => [...r].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
const bytesOf = (s: string) => Buffer.from(s)

describe('FilePreviewTest', () => {
  it('sharedPreferencesAllTypes', () => {
    const t = table(preview('a.xml', 'android-shared-prefs-all-types.xml'))
    expect(t.columns).toEqual(['Key', 'Type', 'Value'])
    const m = byKey(t.rows)
    expect(get(m, 'username')).toEqual(['username', 'string', 'scout & co'])
    expect(get(m, 'onboarded')).toEqual(['onboarded', 'boolean', 'true'])
    expect(get(m, 'launch_count')).toEqual(['launch_count', 'int', '3'])
    expect(get(m, 'last_seen')).toEqual(['last_seen', 'long', '1791119957648'])
    expect(get(m, 'ratio')).toEqual(['ratio', 'float', '0.5'])
    expect(get(m, 'multi')[2]).toBe('line one\nline two')
    expect(get(m, 'tags')[2]).toBe('[a, b]')
    expect(get(m, 'empty_set')[2]).toBe('[]')
    expect(t.rows).toHaveLength(8)
  })

  it('sharedPreferencesPlaygroundAndEncrypted', () => {
    expect(rows(preview('playground_prefs.xml', 'android-shared-prefs-playground.xml')).length).toBeGreaterThan(0)
    const enc = rows(preview('playground_secure_prefs.xml', 'android-shared-prefs-encrypted-playground.xml'))
    expect(enc.some((r) => r[0].startsWith('__androidx_security_crypto'))).toBe(true)
  })

  it('xmlPlistWithDoctypeIsParsedWithoutFetchingTheDtd', () => {
    const r = byKey(rows(preview('x.plist', 'ios-plist-all-types-xml.plist')))
    expect(get(r, 'username')).toEqual(['username', 'string', 'scoutuser'])
    expect(get(r, 'launchCount')).toEqual(['launchCount', 'integer', '3'])
    expect(get(r, 'ratio')).toEqual(['ratio', 'real', '0.5'])
    expect(get(r, 'onboarded')).toEqual(['onboarded', 'bool', 'true'])
    expect(get(r, 'seen')).toEqual(['seen', 'date', '2026-10-04T13:30:00Z'])
    expect(get(r, 'token')).toEqual(['token', 'data', '5 bytes: 48656c6c6f'])
    expect(get(r, 'tags')).toEqual(['tags', 'array', '2 items'])
    expect(get(r, 'tags[0]')[2]).toBe('a')
    expect(get(r, 'nested.k')[2]).toBe('v')
  })

  it('binaryPlistMatchesTheXmlOne', () => {
    const xml = sortedByKey(rows(preview('x.plist', 'ios-plist-all-types-xml.plist')))
    const bin = sortedByKey(rows(preview('x.plist', 'ios-plist-all-types-binary.plist')))
    expect(bin).toEqual(xml)
  })

  it('binaryPlistRealWorldHsts', () => {
    const v = PlistParser.parseBinary(fixtureBytes('ios-plist-binary-hsts.plist'))
    const r = byKey(PlistFlatten.rows(v))
    expect(get(r, 'com.apple.CFNetwork.defaultStorageSession')[1]).toBe('dict')
    expect(get(r, 'com.apple.CFNetwork.defaultStorageSession.en.wikipedia.org.HSTS Host')[2]).toBe('true')
    expect(get(r, 'com.apple.CFNetwork.defaultStorageSession.en.wikipedia.org.Create Time')[2]).toBe('812812958.055501')
  })

  it('binaryPlistRejectsGarbage', () => {
    const good = fixtureBytes('ios-plist-all-types-binary.plist')
    const junk = Buffer.concat([bytesOf('bplist00'), Buffer.alloc(80, 0x7f)])
    for (const bad of [good.subarray(0, 20), good.subarray(0, good.length - 5), junk]) {
      expect(() => PlistParser.parseBinary(Buffer.from(bad))).toThrow(PlistException)
    }
    const p = FilePreview.build('x.plist', junk, 88)
    expect(p.kind === 'Message' && p.text.includes('Unreadable')).toBe(true)
  })

  it('binaryPlistSelfReferenceIsRejected', () => {
    // object 0 is an array of two references to itself: depth alone would allow 2^64 visits.
    const long = (n: number) => {
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(BigInt(n))
      return b
    }
    const out = Buffer.concat([bytesOf('bplist00'), Buffer.from([0xa2, 0, 0]), Buffer.from([8]), Buffer.alloc(6), Buffer.from([1, 1]), long(1), long(0), long(11)])
    expect(() => PlistParser.parseBinary(out)).toThrow(PlistException)
  })

  it('binaryPlistValues', () => {
    // dict {"i": 300, "n": -2, "s": "é"(UTF-16), "u": uid 5, "r": 1.5 (float)}
    const v = PlistParser.parseBinary(handBuiltPlist())
    if (v.kind !== 'Dict') throw new Error('not a dict')
    const d = new Map(v.entries)
    const g = (k: string) => d.get(k)!
    expect(g('i')).toEqual({ kind: 'Int', value: 300n })
    expect(g('n')).toEqual({ kind: 'Int', value: -2n })
    expect(g('s')).toEqual({ kind: 'Str', value: '\u00e9' })
    expect(g('u')).toEqual({ kind: 'Uid', value: 5n })
    expect(g('r')).toEqual({ kind: 'Real', value: 1.5 })
  })

  function handBuiltPlist(): Buffer {
    const parts: number[] = [...bytesOf('bplist00')]
    const offs: number[] = []
    const write = (...b: number[]) => parts.push(...b)
    const long = (n: number) => {
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(BigInt(n))
      return [...b]
    }
    // object 0: dict of 5 pairs, keys refs 1..5, values refs 6..10 (refSize 1)
    offs.push(parts.length)
    write(0xd5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    for (const k of ['i', 'n', 's', 'u', 'r']) {
      offs.push(parts.length)
      write(0x51, ...bytesOf(k))
    }
    offs.push(parts.length)
    write(0x11, 0x01, 0x2c) // 300 (2 bytes)
    offs.push(parts.length)
    write(0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe) // -2 (8 bytes)
    offs.push(parts.length)
    write(0x61, 0x00, 0xe9) // "é"
    offs.push(parts.length)
    write(0x80, 5) // uid 5
    offs.push(parts.length)
    const f = Buffer.alloc(4)
    f.writeFloatBE(1.5)
    write(0x22, ...f)
    const tableAt = parts.length
    write(...offs)
    write(0, 0, 0, 0, 0, 0, 1, 1)
    write(...long(offs.length), ...long(0), ...long(tableAt))
    return Buffer.from(parts)
  }

  it('jsonIsPrettyPrinted', () => {
    const p = FilePreview.build('a.json', bytesOf('{"a":1,"b":[1,2],"c":{"d":"x<y"}}'), 30)
    if (p.kind !== 'Text') throw new Error('not text')
    expect(p.format).toBe('json')
    expect(p.text).toContain('\n  "a": 1')
    expect(p.text).toContain('x<y')
  })

  it('invalidJsonFallsBackToText', () => {
    const p = FilePreview.build('a.json', bytesOf('{not json'), 9)
    expect(p.kind === 'Text' && p.format === 'text').toBe(true)
  })

  it('otherXmlIsPrettyPrinted', () => {
    const p = FilePreview.build('a.xml', bytesOf('<?xml version="1.0"?><root><a>1</a><b><c/></b></root>'), 50)
    expect(p.kind === 'Text' && p.format).toBe('xml')
    expect(p.kind === 'Text' && p.text).toBe('<root>\n  <a>1</a>\n  <b>\n    <c/>\n  </b>\n</root>')
  })

  it('mapWithUntypedChildrenIsNotPrefs', () => {
    expect(FilePreview.build('a.xml', bytesOf('<map><thing a="1"/></map>'), 30).kind).toBe('Text')
  })

  it('xmlWithExternalEntityIsNotFetched', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'
    const p = FilePreview.build('a.xml', bytesOf(xml), xml.length)
    expect(p.kind === 'Text' ? p.text : '').not.toContain('root:')
  })

  it('plainTextAndBinaryAndLimits', () => {
    const text = FilePreview.build('a.txt', bytesOf('hello\nworld'), 11)
    expect(text.kind === 'Text' && text.text).toBe('hello\nworld')
    const empty = FilePreview.build('a', Buffer.alloc(0), 0)
    expect(empty.kind === 'Message' && empty.text).toBe('Empty file')
    const bin = FilePreview.build('a.bin', Buffer.from([1, 2, 0, 3]), 4)
    expect(bin.kind === 'Message' && bin.text.includes('Binary') && bin.text.includes('Download')).toBe(true)
    expect(FilePreview.build('a.bin', Buffer.from([0xc3, 0x28]), 2).kind).toBe('Message')
    const big = FilePreview.build('a.txt', bytesOf('x'), 6 * 1024 * 1024)
    expect(big.kind === 'Message' && big.text.includes('6.0 MB') && big.text.includes('Download')).toBe(true)
    expect(FilePreview.build('a.txt', Buffer.alloc(FilePreview.MAX_BYTES + 1, 'a'), undefined).kind).toBe('Message')
  })

  it('sqliteIsRecognisedByMagic', () => {
    const head = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(100)])
    expect(FilePreview.build('httpstorages.sqlite', head, 4096).kind).toBe('Sqlite')
    // detected before the size cap: a big database still offers the pull
    expect(FilePreview.build('big.db', head, 50 * 1024 * 1024).kind).toBe('Sqlite')
  })

  it('real numbers print like Java BigDecimal', () => {
    const rowOf = (v: number) => PlistFlatten.rows(PlistValue.Dict([['x', PlistValue.Real(v)]]))[0][2]
    expect(rowOf(3)).toBe('3.0')
    expect(rowOf(0.5)).toBe('0.5')
    expect(rowOf(1e10)).toBe('10000000000')
    expect(rowOf(1e-4)).toBe('0.00010')
    expect(rowOf(-2.25)).toBe('-2.25')
  })
})
