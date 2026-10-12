// ported-from: core/inspector/HierarchyParsers.kt
import { rect, type Rect } from '../model'
import { parseXml, type XmlElement } from '../xml'
import { UiNode } from './uiNode'

type Json = unknown
const obj = (v: Json): Record<string, Json> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : undefined)
const primitive = (v: Json): string | undefined => (v === null || v === undefined || typeof v === 'object' ? undefined : String(v))

/** Parses `uiautomator dump` output. */
export const UiAutomatorParser = {
  parseBounds(value: string | undefined): Rect | undefined {
    const m = value ? /\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/.exec(value) : null
    if (!m) return undefined
    const [x1, y1, x2, y2] = m.slice(1).map(Number)
    return rect(x1, y1, x2 - x1, y2 - y1)
  },

  parse(xml: string): UiNode {
    const rootElement = parseXml(xml)
    const root = new UiNode('ANDROID', 'hierarchy', rootElement.attributes)
    for (const child of rootElement.children) root.addChild(UiAutomatorParser.convert(child))
    return root
  },

  convert(element: XmlElement): UiNode {
    const attrs = element.attributes
    const node = new UiNode('ANDROID', attrs.class || 'android.view.View', attrs, UiAutomatorParser.parseBounds(attrs.bounds))
    for (const child of element.children.filter((c) => c.tagName === 'node')) node.addChild(UiAutomatorParser.convert(child))
    return node
  },
}

const toRect = (x: number, y: number, w: number, h: number): Rect | undefined =>
  [x, y, w, h].every((n) => Number.isFinite(n)) ? rect(Math.trunc(x), Math.trunc(y), Math.trunc(w), Math.trunc(h)) : undefined

/** Parses WebDriverAgent `/source` XML. */
export const WdaSourceParser = {
  parse(xml: string): UiNode {
    let rootElement = parseXml(xml)
    if (rootElement.tagName === 'AppiumAUT') rootElement = rootElement.children[0] ?? rootElement
    return WdaSourceParser.convert(rootElement)
  },

  convert(element: XmlElement): UiNode {
    const a = element.attributes
    const bounds = a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined ? toRect(parseFloat(a.x), parseFloat(a.y), parseFloat(a.width), parseFloat(a.height)) : undefined
    const node = new UiNode('IOS', a.type || element.tagName, a, bounds)
    for (const child of element.children) node.addChild(WdaSourceParser.convert(child))
    return node
  },
}

/**
 * Parses `mobilecli dump ui` JSON of an iOS device. Element types come without the "XCUIElementType" prefix; it is
 * restored so locators and XPath match WDA output. The dump has several top level elements, so a synthetic root is added.
 */
export const MobilecliDumpParser = {
  parse(json: string): UiNode {
    const root = obj(JSON.parse(json)) ?? {}
    if (root.status === 'error') throw new Error(primitive(root.error) ?? 'mobilecli dump failed')
    const elements = obj(root.data)?.elements
    if (!Array.isArray(elements)) throw new Error('mobilecli dump has no elements')
    const node = new UiNode('IOS', 'XCUIElementTypeApplication', {})
    for (const e of elements) node.addChild(MobilecliDumpParser.convert(obj(e) ?? {}))
    return node
  },

  convert(o: Record<string, Json>): UiNode {
    const type = primitive(o.type) ?? ''
    // WDA reports name = accessibilityIdentifier, else the label; mobilecli gives identifier explicitly.
    const attrs: Record<string, string> = {}
    const label = primitive(o.label)
    if (label !== undefined) attrs.label = label
    const name = primitive(o.identifier) || primitive(o.name)
    if (name !== undefined) attrs.name = name
    const value = primitive(o.value)
    if (value !== undefined) attrs.value = value
    for (const key of ['enabled', 'visible']) {
      const v = primitive(o[key])
      if (v !== undefined) attrs[key] = v
    }
    const r = obj(o.rect)
    const bounds = r ? toRect(Number(r.x), Number(r.y), Number(r.width), Number(r.height)) : undefined
    const rawType = !type || type.startsWith('XCUIElementType') ? type || 'XCUIElementTypeOther' : `XCUIElementType${type}`
    const node = new UiNode('IOS', rawType, attrs, bounds)
    if (Array.isArray(o.children)) for (const c of o.children) node.addChild(MobilecliDumpParser.convert(obj(c) ?? {}))
    return node
  },
}

/**
 * Parses `mobilecli dump ui --format raw` of an Android device: the same data as `uiautomator dump`, as JSON nested in
 * `data.rawData`. Used when uiautomator itself fails (it is killed on some emulator images).
 */
export const MobilecliAndroidRawParser = {
  copied: ['class', 'text', 'hint', 'content-desc', 'resource-id', 'focused', 'enabled', 'checked', 'checkable', 'clickable', 'selected', 'visible'],

  parse(json: string): UiNode {
    const outer = obj(JSON.parse(json)) ?? {}
    if (outer.status === 'error') throw new Error(primitive(outer.error) ?? 'mobilecli dump failed')
    const raw = obj(outer.data)?.rawData
    if (typeof raw !== 'string') throw new Error('mobilecli dump has no rawData')
    const hierarchy = obj(JSON.parse(raw))?.hierarchy
    if (!Array.isArray(hierarchy)) throw new Error('mobilecli rawData has no hierarchy')
    const root = new UiNode('ANDROID', 'hierarchy', {})
    for (const h of hierarchy) root.addChild(MobilecliAndroidRawParser.convert(obj(h) ?? {}))
    return root
  },

  convert(o: Record<string, Json>): UiNode {
    const attrs: Record<string, string> = {}
    for (const key of MobilecliAndroidRawParser.copied) {
      const v = primitive(o[key])
      if (v !== undefined) attrs[key] = v
    }
    const r = obj(o.rect)
    const bounds = r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number') ? rect(Math.trunc(r.x as number), Math.trunc(r.y as number), Math.trunc(r.width as number), Math.trunc(r.height as number)) : undefined
    const node = new UiNode('ANDROID', attrs.class || 'android.view.View', attrs, bounds)
    if (Array.isArray(o.children)) for (const c of o.children) node.addChild(MobilecliAndroidRawParser.convert(obj(c) ?? {}))
    return node
  },
}
