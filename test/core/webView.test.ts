// ported-from: test:core/WebViewTest.kt
import { describe, expect, it } from 'vitest'
import { UiNode } from '../../src/core/inspector/uiNode'
import { MobilecliException, MobilecliJson } from '../../src/core/mobilecliJson'
import type { Rect } from '../../src/core/model'
import { DomNode, DomTree, WebRectMapper, WebViewEval, WebViews, type DomPage } from '../../src/core/webview/webView'
import { LiveCheck, WebLocators, matchText } from '../../src/core/webview/webLocators'
import { fixture } from '../helpers/fixtures'

const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const androidPage = (() => DomTree.parse(fixture('mobilecli-webview-tree-android.json')))()
const iosPage = (() => DomTree.parse(fixture('mobilecli-webview-tree-ios.json')))()
const find = (page: DomPage, pred: (n: DomNode) => boolean): DomNode => {
  for (const n of page.root.descendants()) if (pred(n)) return n
  throw new Error('no such node')
}
const page = (json: string): DomPage => DomTree.parse(`{"status":"ok","data":${json}}`)
const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}
const err = (name: string): string => MobilecliJson.errorMessage(fixture(name), '')

describe('WebViewTest', () => {
  // list

  it('list parses android and ios', () => {
    const a = WebViews.parseList(fixture('mobilecli-webview-list-android.json'))
    expect(a).toHaveLength(1)
    expect(a[0].id).toBe('b11ce8a')
    expect(a[0].title).toBe('Sample Login')
    expect(a[0].bundleId).toBe('com.mobilenext.playground')
    expect(a[0].bounds).toEqual(R(0, 289, 1080, 2135))
    expect(a[0].visible).toBe(true)
    expect(a[0].label).toBe('Sample Login  -  mobilewright.dev/samples/webview/  -  com.mobilenext.playground')
    const i = WebViews.parseList(fixture('mobilecli-webview-list-ios.json'))
    expect(i).toHaveLength(1)
    expect(i[0].id).toBe('0x105eac000')
    expect(i[0].bundleId).toBe('')
    expect(i[0].bounds).toEqual(R(0, 116, 402, 758))
  })

  it('empty list and no data', () => {
    expect(WebViews.parseList('{"status":"ok","data":[]}')).toEqual([])
    expect(WebViews.parseList('{"status":"ok"}')).toEqual([])
  })

  it("list error is thrown with mobilecli's text", () => {
    const e = thrown(() => WebViews.parseList(fixture('mobilecli-webview-list-error-android.json')))
    expect(e).toBeInstanceOf(MobilecliException)
    expect((e as Error).message).toContain('not debuggable')
  })

  // errors

  it('clean error strips agent prefixes', () => {
    expect(WebViews.cleanError('webview evaluate failed: agent error -32603: Internal error: foo is not defined')).toBe('foo is not defined')
    expect(WebViews.cleanError("webview evaluate failed: agent error -32000: ReferenceError: Can't find variable: foo")).toBe("ReferenceError: Can't find variable: foo")
    expect(WebViews.cleanError(err('mobilecli-webview-eval-unsupported-ios.json'))).toBe('JavaScript execution returned a result of an unsupported type')
    expect(WebViews.cleanError(err('mobilecli-webview-eval-throw-ios.json'))).toBe('Error: boom')
  })

  it('debug build hint', () => {
    const android = err('mobilecli-webview-list-error-android.json')
    const ios = err('mobilecli-webview-list-error-ios.json')
    expect(WebViews.needsDebugBuild(android)).toBe(true)
    expect(WebViews.needsDebugBuild(ios)).toBe(true)
    expect(WebViews.describeError(android)).toContain('debug builds')
    expect(WebViews.describeError(ios)).toContain('get-task-allow')
    expect(WebViews.needsDebugBuild('foo is not defined')).toBe(false)
    expect(WebViews.describeError('foo is not defined')).not.toContain('debug')
  })

  it('not found detection', () => {
    expect(WebViews.isNotFound(err('mobilecli-webview-eval-notfound-android.json'))).toBe(true)
    expect(WebViews.isNotFound(err('mobilecli-webview-eval-notfound-ios.json'))).toBe(true)
    expect(WebViews.isNotFound('foo is not defined')).toBe(false)
  })

  // eval

  it('expression wraps the script as an indirect eval of a json string', () => {
    expect(WebViewEval.expression('1+1 // c')).toBe('(0,eval)("1+1 // c")')
    expect(WebViewEval.expression('-1')).toBe('(0,eval)("-1")')
    expect(WebViewEval.expression('a\nb "q" <x>')).toBe('(0,eval)("a\\nb \\"q\\" <x>")')
    expect(WebViewEval.args('abc', '2')).toEqual(['webview', 'eval', 'abc', '(0,eval)("2")'])
    expect(WebViewEval.expression('-1').startsWith('(')).toBe(true)
  })

  it('format of results', () => {
    expect(WebViewEval.format('{"status":"ok","data":2}')).toEqual({ text: '2', error: false })
    const obj = WebViewEval.format(fixture('mobilecli-webview-eval-object-android.json'))
    expect(obj.error).toBe(false)
    expect(obj.text).toContain('"a": 1')
    const undef = WebViewEval.format(fixture('mobilecli-webview-eval-undefined.json'))
    expect(undef.error).toBe(false)
    expect(undef.text.startsWith('undefined')).toBe(true)
    expect(WebViewEval.format('{"status":"ok","data":"hi <b>"}').text).toBe('"hi <b>"')
  })

  it('format of errors', () => {
    const e = WebViewEval.format(fixture('mobilecli-webview-eval-error-android.json'))
    expect(e.error).toBe(true)
    expect(e.text).toBe('foo is not defined')
    const u = WebViewEval.formatError(err('mobilecli-webview-eval-unsupported-ios.json'))
    expect(u.error).toBe(true)
    expect(u.text).toContain('JSON.stringify')
    expect(u.text).not.toContain('body[')
  })

  // tree

  it('parses the android tree', () => {
    const p = androidPage
    expect(p.dpr).toBeCloseTo(2.625, 4)
    expect(p.innerWidth).toBe(411.0)
    expect(p.count).toBe(17)
    expect(p.truncated).toBe(false)
    expect(p.root.tag).toBe('html')
    const input = find(p, (n) => n.id === 'name')
    expect(input.tag).toBe('input')
    expect(input.label).toBe('input#name')
    expect(input.path).toEqual([1, 0, 1, 0, 1])
    expect(find(p, (n) => n.tag === 'button').text).toBe('Submit')
    expect(find(p, (n) => n.classes.includes('container')).label).toBe('div.container')
    expect(find(p, (n) => n.tag === 'script').isNonVisual).toBe(true)
    expect([...p.root.descendants()]).toHaveLength(p.count)
  })

  it('parses the ios tree and accepts a plain object as data', () => {
    expect(iosPage.innerWidth).toBe(402.0)
    expect(iosPage.dpr).toBe(3.0)
    const plain = DomTree.parse('{"status":"ok","data":{"iw":10,"root":{"t":"html","a":{},"x":"","r":[0,0,10,10],"k":[]}}}')
    expect(plain.count).toBe(1)
  })

  it('truncation uses total or a full cap', () => {
    const capped = DomTree.parse('{"status":"ok","data":{"iw":10,"count":2000,"total":14123,"root":{"t":"html","a":{},"x":"","r":[0,0,1,1],"k":[]}}}')
    expect(capped.truncated).toBe(true)
    expect(capped.note).toBe('showing the first 2000 of 14123 elements')
    const full = DomTree.parse('{"status":"ok","data":{"iw":10,"count":2000,"root":{"t":"html","a":{},"x":"","r":[0,0,1,1],"k":[]}}}')
    expect(full.truncated).toBe(true)
    expect(androidPage.note).toBe('17 elements')
  })

  it('tree failures', () => {
    expect(thrown(() => DomTree.parse('{"status":"ok"}'))).toBeInstanceOf(Error)
    expect(thrown(() => DomTree.parse('{"status":"error","error":"x"}'))).toBeInstanceOf(MobilecliException)
  })

  it('tree script is the verified fixture plus the cap and the real total', () => {
    const fixtureScript = fixture('webview-tree-script.js').trim()
    const s = DomTree.script(2000)
    expect(s.startsWith('JSON.stringify(')).toBe(true)
    expect(s).toContain('MAX=2000')
    expect(s).toContain("total:document.getElementsByTagName('*').length")
    // The walker itself is unchanged from the script verified on the devices.
    const after = fixtureScript.slice(fixtureScript.indexOf('(function(){') + '(function(){'.length)
    const walker = after.slice(0, after.indexOf('return {dpr'))
    expect(s).toContain(walker)
    expect(DomTree.script(50)).toContain('MAX=50')
    expect(WebViewEval.expression(s).startsWith('(0,eval)("')).toBe(true)
  })

  // locators

  it('css prefers a unique id', () => {
    const input = find(androidPage, (n) => n.id === 'name')
    const css = WebLocators.cssSelector(input, androidPage.root)
    expect(css.value).toBe('#name')
    expect(css.domCount).toBe(1)
    const xp = WebLocators.xpath(input, androidPage.root)
    expect(xp.value).toBe("//input[@id='name']")
    expect(xp.domCount).toBe(1)
  })

  it('css without id uses a unique class or falls back to a path', () => {
    const container = find(androidPage, (n) => n.classes.includes('container'))
    expect(WebLocators.cssSelector(container, androidPage.root).value).toBe('div.container')
    const button = find(androidPage, (n) => n.tag === 'button')
    const css = WebLocators.cssSelector(button, androidPage.root)
    expect(css.domCount).toBe(1)
    expect(css.value).toBe('#loginForm > button')
    expect(WebLocators.xpath(button, androidPage.root).value).toBe("//*[@id='loginForm']/button")
    const h1 = find(androidPage, (n) => n.tag === 'h1')
    expect(WebLocators.cssSelector(h1, androidPage.root).value).toBe('div.container > h1')
    expect(WebLocators.xpath(h1, androidPage.root).value).toBe('/html/body/div[1]/h1')
  })

  const list = page(
    `{"iw":100,"root":{"t":"html","a":{},"x":"","r":[0,0,1,1],"k":[{"t":"body","a":{},"x":"","r":[0,0,1,1],"k":[
        {"t":"ul","a":{"id":"menu"},"x":"","r":[0,0,1,1],"k":[
          {"t":"li","a":{"class":"item"},"x":"A","r":[0,0,1,1],"k":[]},
          {"t":"li","a":{"class":"item"},"x":"B","r":[0,0,1,1],"k":[]},
          {"t":"li","a":{"class":"item","data-testid":"third"},"x":"C","r":[0,0,1,1],"k":[]}]},
        {"t":"ul","a":{},"x":"","r":[0,0,1,1],"k":[
          {"t":"li","a":{"class":"item"},"x":"D","r":[0,0,1,1],"k":[]}]}]}]}}`,
  )

  it('duplicates are disambiguated and counted', () => {
    const items = [...list.root.descendants()].filter((n) => n.tag === 'li')
    const second = items[1]
    const css = WebLocators.cssSelector(second, list.root)
    expect(css.value).toBe('#menu > li:nth-of-type(2)')
    expect(css.domCount).toBe(1)
    expect(WebLocators.xpath(second, list.root).value).toBe("//*[@id='menu']/li[2]")
    // a test id wins over the path
    expect(WebLocators.cssSelector(items[2], list.root).value).toBe('li[data-testid="third"]')
    expect(WebLocators.xpath(items[2], list.root).value).toBe("//li[@data-testid='third']")
    // an element in the second list (no id) needs the ancestor path
    const d = items[3]
    const dc = WebLocators.cssSelector(d, list.root)
    expect(dc.domCount).toBe(1)
    expect(dc.value).toBe('ul:nth-of-type(2) > li')
    expect(WebLocators.xpath(d, list.root).value).toBe('/html/body/ul[2]/li')
  })

  it('quoting', () => {
    expect(WebLocators.quote('a"b')).toBe('"a\\"b"')
    expect(WebLocators.xpathLiteral('abc')).toBe("'abc'")
    expect(WebLocators.xpathLiteral("it's")).toBe('"it\'s"')
    expect(WebLocators.xpathLiteral('a\'b"c')).toBe('concat(\'a\', "\'", \'b"c\')')
  })

  it('an id that is not a css identifier uses an attribute selector in paths', () => {
    const p = page(`{"iw":1,"root":{"t":"html","a":{},"x":"","r":[0,0,1,1],"k":[{"t":"body","a":{},"x":"","r":[0,0,1,1],"k":[
            {"t":"div","a":{"id":"1 a"},"x":"","r":[0,0,1,1],"k":[{"t":"p","a":{},"x":"","r":[0,0,1,1],"k":[]}]}]}]}}`)
    const pNode = find(p, (n) => n.tag === 'p')
    expect(WebLocators.cssSelector(pNode, p.root).value).toBe('[id="1 a"] > p')
  })

  // live check

  it('live check script embeds selectors as string literals and the path', () => {
    const s = LiveCheck.script('input[name="x"]', "//a[@id='b']", [1, 0, 2])
    expect(s).toContain('querySelectorAll("input[name=\\"x\\"]")')
    expect(s).toContain('document.evaluate("//a[@id=\'b\']"')
    expect(s).toContain('var p=[1,0,2]')
    expect(s.endsWith('JSON.stringify(o)})()')).toBe(true)
  })

  it('live check parse', () => {
    const out = '{"status":"ok","data":"{\\"css\\":1,\\"xpath\\":2,\\"rect\\":[25.7,386.7,360,50.5],\\"vw\\":411.4}"}'
    const c = LiveCheck.parse(out)
    expect(c.cssCount).toBe(1)
    expect(c.xpathCount).toBe(2)
    expect(c.cssError).toBeUndefined()
    expect(c.viewportWidth).toBe(411.4)
    expect(c.rect![3]).toBe(50.5)
    const bad = LiveCheck.parse(
      '{"status":"ok","data":"{\\"cssError\\":\\"Failed to execute \'querySelectorAll\' on \'Document\': \'div[[\' is not a valid selector.\\",\\"xpath\\":0,\\"iw\\":402}"}',
    )
    expect(bad.cssCount).toBeUndefined()
    expect(bad.cssError).toBeDefined()
    expect(matchText(bad.cssCount, bad.cssError)).toBe(`invalid: ${bad.cssError}`)
    expect(matchText(bad.xpathCount)).toBe('no match')
  })

  it('match text', () => {
    expect(matchText(1)).toBe('1 match (unique)')
    expect(matchText(3)).toBe('3 matches')
    expect(matchText(undefined)).toBe('not checked')
  })

  // rect mapping, verified numbers from the devices

  it('maps a css rect to device coordinates', () => {
    const android = WebRectMapper.toDevice([25.714, 386.667, 360.0, 50.476], 411.4, R(0, 289, 1080, 2135))!
    expect(android).toEqual(R(68, 1304, 945, 133)) // device x 67.5, y 1304.0, w 945, h 132.5 measured on the emulator
    const ios = WebRectMapper.toDevice([24.0, 342.0, 354.0, 52.0], 402.0, R(0, 116, 402, 758))!
    expect(ios).toEqual(R(24, 458, 354, 52))
    expect(WebRectMapper.toDevice([0, 0, 0, 0], 402.0, R(0, 116, 402, 758))).toBeUndefined()
    expect(WebRectMapper.toDevice([1, 1, 5, 5], 0.0, R(0, 116, 402, 758))).toBeUndefined()
  })

  // native owner

  it('native owner is found by rect', () => {
    const root = new UiNode('ANDROID', 'hierarchy', {}, R(0, 0, 1080, 2424))
    const frame = new UiNode('ANDROID', 'android.widget.FrameLayout', {}, R(0, 289, 1080, 2135))
    const wv = new UiNode('ANDROID', 'android.webkit.WebView', {}, R(0, 289, 1080, 2135))
    root.addChild(frame)
    frame.addChild(wv)
    expect(WebViews.nativeOwner(root, R(0, 289, 1080, 2135))).toBe(wv)
    expect(WebViews.describeOwner(wv)).toBe('android.webkit.WebView at 0,289 1080x2135')
    expect(WebViews.nativeOwner(root, R(0, 0, 10, 10))).toBeUndefined()
    // without a WebView node (iOS) no owner is claimed: only the bounds are known
    const ios = new UiNode('IOS', 'XCUIElementTypeApplication', {}, R(0, 0, 402, 874))
    const other = new UiNode('IOS', 'XCUIElementTypeOther', {}, R(0, 116, 402, 758))
    ios.addChild(other)
    expect(WebViews.nativeOwner(ios, R(0, 116, 402, 758))).toBeUndefined()
  })

  it('rect is clipped to the web view bounds', () => {
    const b = R(0, 100, 400, 600)
    expect(WebRectMapper.clip(R(10, 650, 100, 200), b)).toEqual(R(10, 650, 100, 50))
    expect(WebRectMapper.clip(R(10, 900, 100, 50), b)).toBeUndefined()
    expect(WebRectMapper.clip(R(10, 20, 100, 50), b)).toBeUndefined()
  })

  it('xpath uses local-name for svg elements', () => {
    const box = [0, 0, 1, 1]
    const html = new DomNode('html', new Map(), '', box, [], undefined)
    const svg = new DomNode('svg', new Map([['id', 'x']]), '', box, [0], html)
    const path = new DomNode('path', new Map(), '', box, [0, 0], svg)
    html.add(svg)
    svg.add(path)
    expect(WebLocators.xpath(svg, html).value).toBe("//*[local-name()='svg'][@id='x']")
    expect(WebLocators.xpath(path, html).value).toBe("//*[@id='x']/*[local-name()='path']")
  })
})
