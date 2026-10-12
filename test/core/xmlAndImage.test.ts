// Tests for the two helpers that have no Kotlin counterpart (src/core/xml.ts, src/core/image/dimensions.ts).
import { describe, expect, it } from 'vitest'
import { imageSize, toFrame } from '../../src/core/image/dimensions'
import { UiAutomatorParser, MobilecliAndroidRawParser } from '../../src/core/inspector/hierarchyParsers'
import { parseXml } from '../../src/core/xml'
import { fixture } from '../helpers/fixtures'

describe('xml', () => {
  it('parses attributes, nesting, entities and trailing text', () => {
    const root = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b/><c y=\'q\'>t&lt;</c></a>\nUI hierchary dumped to: /x')
    expect(root.attributes.x).toBe('1 & 2')
    expect(root.children.map((c) => c.tagName)).toEqual(['b', 'c'])
    expect(root.children[1].text).toBe('t<')
  })

  it('rejects DOCTYPE and broken input', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a/>')).toThrow(/DOCTYPE/)
    expect(() => parseXml('<a><b></a>')).toThrow()
    expect(() => parseXml('nothing')).toThrow()
  })

  it('reads the uiautomator fixture', () => {
    const root = UiAutomatorParser.parse(fixture('android_login.xml'))
    expect([...root.walk()].length).toBeGreaterThan(3)
    expect(root.children[0].bounds).toBeDefined()
  })
})

describe('image', () => {
  it('reads PNG and JPEG sizes', () => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12)
    png.writeUInt32BE(1080, 16)
    png.writeUInt32BE(2400, 20)
    expect(imageSize(png)).toEqual({ width: 1080, height: 2400 })
    // SOI, APP0 (length 16), SOF0 with height 640 and width 480.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0xe0, 0x03]), Buffer.alloc(20)])
    expect(imageSize(jpeg)).toEqual({ width: 480, height: 640 })
    expect(toFrame(Buffer.from('not an image'))).toBeUndefined()
  })
})

describe('mobilecli raw hierarchy', () => {
  it('rejects an envelope without rawData', () => {
    expect(() => MobilecliAndroidRawParser.parse('{"status":"ok","data":{}}')).toThrow(/rawData/)
  })
})
