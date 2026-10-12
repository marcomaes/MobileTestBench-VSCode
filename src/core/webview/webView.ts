// ported-from: core/webview/WebView.kt
import { MobilecliJson } from '../mobilecliJson'
import type { Rect } from '../model'
import type { UiNode } from '../inspector/uiNode'

type Json = unknown
const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (o: Record<string, Json>, k: string): string | undefined => {
  const v = o[k]
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
}
const int = (o: Record<string, Json>, k: string): number => {
  const v = o[k]
  return typeof v === 'number' ? Math.round(v) : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Math.round(Number(v)) : 0
}

/** A web view of the foreground app as `mobilecli webview list` reports it. [bounds] are device pixels (Android) or points (iOS). */
export class WebViewInfo {
  constructor(
    readonly id: string,
    readonly url: string,
    readonly title: string,
    readonly bundleId: string,
    readonly bounds: Rect | undefined,
    readonly visible: boolean,
  ) {}

  /** One line for the combo box. */
  get label(): string {
    const name = this.title.trim() ? this.title : this.url.trim() ? this.url : this.id
    const stripped = this.url.replace(/^https:\/\//, '').replace(/^http:\/\//, '')
    const shortUrl = stripped.includes('?') ? stripped.slice(0, stripped.indexOf('?')) : stripped
    const parts = [name, shortUrl.trim() && shortUrl !== name ? shortUrl : undefined, this.bundleId.trim() ? this.bundleId : undefined].filter((p): p is string => p !== undefined)
    return parts.join('  -  ') + (this.visible ? '' : '  (hidden)')
  }
}

/** Pure parsing of `mobilecli webview` output and the messages shown for its errors. */
export const WebViews = {
  parseList(stdout: string): WebViewInfo[] {
    const data = MobilecliJson.data(stdout)
    if (!Array.isArray(data)) return []
    const out: WebViewInfo[] = []
    for (const e of data) {
      if (!isObject(e)) continue
      const id = str(e, 'id')
      if (id === undefined) continue
      const b = e.bounds
      const bounds = isObject(b) ? { x: int(b, 'x'), y: int(b, 'y'), width: int(b, 'width'), height: int(b, 'height') } : undefined
      const vis = e.isVisible
      out.push(new WebViewInfo(id, str(e, 'url') ?? '', str(e, 'title') ?? '', str(e, 'bundleId') ?? '', bounds, typeof vis === 'boolean' ? vis : true))
    }
    return out
  },

  /**
   * mobilecli's error text without the agent noise: `webview evaluate failed: agent error -32603: Internal error: foo is not defined` becomes
   * `foo is not defined`, and the iOS debug tail ` || body[0:120]=...` is cut.
   */
  cleanError(message: string): string {
    const cut = message.indexOf(' || body[')
    let m = (cut >= 0 ? message.slice(0, cut) : message).trim()
    m = m.replace(/^webview (evaluate|list|query) failed: /, '')
    m = m.replace(/^agent error -?\d+: /, '')
    if (m.startsWith('Internal error: ')) m = m.slice('Internal error: '.length)
    return m.trim() === '' ? 'webview command failed' : m
  },

  /** True for the "not a debug build" family of errors (Android: not debuggable, iOS: no get-task-allow). */
  needsDebugBuild(message: string): boolean {
    const m = message.toLowerCase()
    return m.includes('debug build') || m.includes('not debuggable') || m.includes('get-task-allow')
  },

  /** The error shown in the status line: the cleaned text plus a hint when the app is not a debug build. */
  describeError(message: string): string {
    const clean = WebViews.cleanError(message)
    return WebViews.needsDebugBuild(message) ? `${clean}. Web views can only be inspected in debug builds (Android: debuggable app, iOS: get-task-allow entitlement).` : clean
  },

  /** True when the web view is gone (its id is stale, for example after leaving and re-entering the screen). */
  isNotFound: (message: string): boolean => message.toLowerCase().includes('webview not found') || message.includes('-32100'),

  /** The native element that owns the web view: a node whose type contains "WebView" (Android `android.webkit.WebView`) with the same rect. iOS has no such node, so there only the bounds are known. */
  nativeOwner(root: UiNode, bounds: Rect, tolerance = 2): UiNode | undefined {
    const close = (a: Rect): boolean =>
      Math.abs(a.x - bounds.x) <= tolerance && Math.abs(a.y - bounds.y) <= tolerance && Math.abs(a.width - bounds.width) <= tolerance && Math.abs(a.height - bounds.height) <= tolerance
    const matches: UiNode[] = []
    const walk = (n: UiNode): void => {
      if (n.bounds && close(n.bounds)) matches.push(n)
      n.children.forEach(walk)
    }
    walk(root)
    return matches.find((n) => n.rawType.toLowerCase().includes('webview'))
  },

  /** `android.webkit.WebView at 0,289 1080x2135` style text for the owner. */
  describeOwner(node: UiNode): string {
    const b = node.bounds
    return node.rawType + (b ? ` at ${b.x},${b.y} ${b.width}x${b.height}` : '')
  },
}

/** Result of a console evaluation: [text] is the pretty JSON (or "undefined"), [error] when the page or the web view failed. */
export interface EvalOutcome {
  readonly text: string
  readonly error: boolean
}

const MAX_RESULT_CHARS = 200_000

/** Building and reading `mobilecli webview eval` calls. */
export const WebViewEval = {
  /**
   * The argument for `webview eval`. mobilecli wraps the expression as `return (EXPR)`, which breaks statements, comments and `throw`,
   * and cobra reads a leading `-` as a flag. An indirect eval of a JSON string literal avoids both and returns the completion value.
   */
  expression: (script: string): string => `(0,eval)(${JSON.stringify(script)})`,

  /** The arguments after `mobilecli`: `webview eval <id> <expr>`. */
  args: (webViewId: string, script: string): string[] => ['webview', 'eval', webViewId, WebViewEval.expression(script)],

  /** Reads a successful eval envelope: an envelope without `data` is JavaScript undefined or null. Throws on an error envelope. */
  result: (stdout: string): Json | undefined => MobilecliJson.data(stdout),

  /** The console view of [stdout] (success) as an [EvalOutcome]. */
  format(stdout: string): EvalOutcome {
    if (MobilecliJson.isError(stdout)) return { text: WebViews.cleanError(MobilecliJson.errorMessage(stdout, '')), error: true }
    const data = WebViewEval.result(stdout)
    if (data === undefined) return { text: 'undefined (or null, mobilecli reports both as no value)', error: false }
    const text = typeof data === 'string' ? JSON.stringify(data) : JSON.stringify(data, null, 2)
    return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n... cut at ${MAX_RESULT_CHARS} characters` : text, error: false }
  },

  /** The console view of a failure message thrown by the mobilecli call, with a hint for the results mobilecli cannot convert. */
  formatError(message: string): EvalOutcome {
    const clean = WebViews.cleanError(message)
    const hint = clean.toLowerCase().includes('unsupported type') ? '\nReturn a primitive or JSON, for example JSON.stringify(value).' : ''
    return { text: clean + hint, error: true }
  },
}

/** One element of the page as the tree script reports it. [path] is the index among the element children of each parent, from `<html>` down. */
export class DomNode {
  static readonly NON_VISUAL: ReadonlySet<string> = new Set(['head', 'script', 'style', 'meta', 'link', 'title', 'noscript', 'template', 'base'])
  private readonly _children: DomNode[] = []

  constructor(
    readonly tag: string,
    readonly attributes: ReadonlyMap<string, string>,
    readonly text: string,
    /** Viewport relative rect in CSS pixels: x, y, width, height. */
    readonly rect: readonly number[],
    readonly path: readonly number[],
    readonly parent: DomNode | undefined,
  ) {}

  get children(): readonly DomNode[] {
    return this._children
  }

  add(child: DomNode): void {
    this._children.push(child)
  }

  get id(): string | undefined {
    const v = this.attributes.get('id')
    return v !== undefined && v.trim() !== '' ? v : undefined
  }

  get classes(): string[] {
    return (this.attributes.get('class') ?? '').split(/\s+/).filter((c) => c.length > 0)
  }

  /** `tag#id.class1.class2` as shown in the tree. */
  get label(): string {
    return this.tag + (this.id !== undefined ? `#${this.id}` : '') + this.classes.map((c) => `.${c}`).join('')
  }

  get isNonVisual(): boolean {
    return DomNode.NON_VISUAL.has(this.tag)
  }

  *descendants(): Generator<DomNode> {
    yield this
    for (const c of this._children) yield* c.descendants()
  }
}

/** A parsed page: the root and the viewport facts needed to map rects to the device. */
export class DomPage {
  constructor(
    readonly root: DomNode,
    readonly dpr: number,
    readonly innerWidth: number,
    readonly innerHeight: number,
    readonly count: number,
    readonly total: number | undefined,
    readonly limit: number,
  ) {}

  /** The CSS width the rects are relative to: the `<html>` width (fractional, exact), else the rounded `innerWidth`. */
  get viewportWidth(): number {
    return this.root.rect[2] > 0 ? this.root.rect[2] : this.innerWidth
  }

  /** True when the page has more elements than were loaded. With an unknown total (older script), a full cap counts as truncated. */
  get truncated(): boolean {
    return this.total !== undefined ? this.total > this.count : this.count >= this.limit
  }

  get note(): string {
    return this.truncated ? `showing the first ${this.count} of ${this.total ?? `more than ${this.count}`} elements` : `${this.count} elements`
  }
}

const num = (v: Json, fallback: number): number => (typeof v === 'number' ? v : fallback)

const DEFAULT_LIMIT = 2000

export const DomTree = {
  DEFAULT_LIMIT,

  /**
   * Parses the result of the tree script: [stdout] is the eval envelope whose `data` is a JSON string (the script returns
   * `JSON.stringify(...)`), but a plain object `data` is accepted too.
   */
  parse(stdout: string, limit = DEFAULT_LIMIT): DomPage {
    const data = MobilecliJson.data(stdout)
    if (data === undefined) throw new Error('The web view returned nothing')
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    if (!isObject(parsed)) throw new Error('The web view returned no object')
    if (!isObject(parsed.root)) throw new Error('The DOM has no root element')
    const root = domNode(parsed.root, undefined, [])
    const count = typeof parsed.count === 'number' ? Math.trunc(parsed.count) : [...root.descendants()].length
    const total = typeof parsed.total === 'number' ? Math.trunc(parsed.total) : undefined
    return new DomPage(root, num(parsed.dpr, 1.0), num(parsed.iw, 0.0), num(parsed.ih, 0.0), count, total, limit)
  },

  /**
   * The script whose `JSON.stringify` result [parse] reads: the whole DOM as compact JSON (tag, attributes, own text, rect) with
   * a cap of [limit] elements and the real element count in `total`. Text is the element's own text nodes, 80 characters at most.
   */
  script: (limit = DEFAULT_LIMIT): string =>
    `JSON.stringify((function(){var MAX=${limit},n=0;function w(e,d){if(n>=MAX)return null;n++;var r=e.getBoundingClientRect(),a={};` +
    'for(var i=0;i<e.attributes.length;i++){a[e.attributes[i].name]=e.attributes[i].value.slice(0,200)}' +
    "var t='';for(var c=e.firstChild;c;c=c.nextSibling){if(c.nodeType==3)t+=c.nodeValue}" +
    "t=t.replace(/\\s+/g,' ').trim().slice(0,80);" +
    "var o={t:e.tagName.toLowerCase(),a:a,x:t,r:[Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10],k:[]};" +
    'if(d<40)for(var c=e.firstElementChild;c;c=c.nextElementSibling){var s=w(c,d+1);if(s)o.k.push(s)}return o}' +
    'return {dpr:window.devicePixelRatio,iw:innerWidth,ih:innerHeight,sx:scrollX,sy:scrollY,root:w(document.documentElement,0),count:n,' +
    "total:document.getElementsByTagName('*').length}})())",
}

function domNode(o: Record<string, Json>, parent: DomNode | undefined, path: number[]): DomNode {
  const attrs = new Map<string, string>()
  if (isObject(o.a)) for (const [k, v] of Object.entries(o.a)) attrs.set(k, String(v))
  const r = Array.isArray(o.r) && o.r.length === 4 ? o.r.map(Number) : [0, 0, 0, 0]
  if (typeof o.t !== 'string') throw new Error('A DOM node has no tag')
  const n = new DomNode(o.t, attrs, typeof o.x === 'string' ? o.x : '', r, path, parent)
  if (Array.isArray(o.k)) o.k.forEach((k, i) => n.add(domNode(k as Record<string, Json>, n, [...path, i])))
  return n
}

/**
 * Maps a viewport relative CSS rect to device coordinates: the web view's [webViewBounds] (from `webview list`) scaled by
 * bounds.width / viewport width (the html element width, which is exact where innerWidth is rounded), so the device pixel ratio is not needed (Android: pixels, iOS: points; verified on both).
 */
export const WebRectMapper = {
  toDevice(rect: readonly number[], cssViewportWidth: number, webViewBounds: Rect): Rect | undefined {
    if (rect.length !== 4 || cssViewportWidth <= 0 || webViewBounds.width <= 0) return undefined
    if (rect[2] <= 0 || rect[3] <= 0) return undefined // not rendered
    const f = webViewBounds.width / cssViewportWidth
    return {
      x: Math.round(webViewBounds.x + rect[0] * f),
      y: Math.round(webViewBounds.y + rect[1] * f),
      width: Math.max(Math.round(rect[2] * f), 1),
      height: Math.max(Math.round(rect[3] * f), 1),
    }
  },

  /** The part of [rect] inside [webViewBounds], or undefined when none of it is visible (scrolled out, or under the native toolbar). */
  clip(rect: Rect, webViewBounds: Rect): Rect | undefined {
    const x1 = Math.max(rect.x, webViewBounds.x)
    const y1 = Math.max(rect.y, webViewBounds.y)
    const x2 = Math.min(rect.x + rect.width, webViewBounds.x + webViewBounds.width)
    const y2 = Math.min(rect.y + rect.height, webViewBounds.y + webViewBounds.height)
    return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined
  },
}
