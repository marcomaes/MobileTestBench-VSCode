// ported-from: ui/WebViewPanel.kt
// Host half of the WebView tab: every `mobilecli webview ...` call, the DOM page, the locators with their live check and the highlight on the
// mirror. The webview half shows the tree, the locators and the console. A late result of another web view, selection or run is dropped
// through the generation counters.
import type { Device } from '../../core/model'
import type { Rect } from '../../core/model'
import { DomTree, WebRectMapper, WebViewEval, WebViews, type DomNode, type DomPage, type WebViewInfo } from '../../core/webview/webView'
import { LiveCheck, WebLocators, matchText } from '../../core/webview/webLocators'
import type { ToolContext, ToolHost } from './toolHost'

interface State {
  ctx: ToolContext
  visible: boolean
  listGen: number
  treeGen: number
  selGen: number
  evalGen: number
  webViews: WebViewInfo[]
  current: WebViewInfo | undefined
  page: DomPage | undefined
  nodes: Map<string, DomNode>
  selected: DomNode | undefined
  highlighted: boolean
}

// One ToolHost serves every open viewer, so the state is kept per device object (the viewer hands out a fresh ToolContext per call).
const states = new WeakMap<Device, State>()

function stateOf(ctx: ToolContext): State {
  let st = states.get(ctx.device)
  if (!st) {
    st = { ctx, visible: false, listGen: 0, treeGen: 0, selGen: 0, evalGen: 0, webViews: [], current: undefined, page: undefined, nodes: new Map(), selected: undefined, highlighted: false }
    states.set(ctx.device, st)
  }
  st.ctx = ctx
  return st
}

interface TreeDto {
  key: string
  label: string
  text: string
  nonVisual: boolean
  children: TreeDto[]
}

interface Listing {
  views: Array<{ id: string; label: string }>
  currentId: string | undefined
  status: { text: string; error: boolean }
  tree: TreeDto | undefined
  owner: string
  /** True when this listing came from the automatic re-list after a stale web view id. */
  stale?: boolean
}

const msg = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback)
const keyOf = (path: readonly number[]): string => path.join(',')

function clearHighlight(st: State): void {
  if (st.highlighted) st.ctx.highlight([])
  st.highlighted = false
}

function treeDto(st: State, n: DomNode): TreeDto {
  st.nodes.set(keyOf(n.path), n)
  return { key: keyOf(n.path), label: n.label, text: n.text, nonVisual: n.isNonVisual, children: n.children.map((c) => treeDto(st, c)) }
}

function viewsDto(st: State): Array<{ id: string; label: string }> {
  return st.webViews.map((w) => ({ id: w.id, label: w.label }))
}

/** `loadDom` of the Kotlin panel: evals the tree script and finds the native owner. */
async function loadDom(st: State, retried: boolean): Promise<Listing | undefined> {
  const dev = st.ctx.device
  const info = st.current
  if (!info) return { views: viewsDto(st), currentId: undefined, status: { text: 'No web view', error: false }, tree: undefined, owner: '' }
  const my = ++st.treeGen
  st.selGen++
  st.selected = undefined
  clearHighlight(st)
  let page: DomPage | undefined
  let failure: string | undefined
  try {
    page = DomTree.parse(await st.ctx.services.mobilecliCall(dev, WebViewEval.args(info.id, DomTree.script())))
  } catch (e) {
    failure = msg(e, 'webview eval failed')
  }
  // The native element with the same rect owns the web view (best effort, never fails the load).
  let ownerText: string | undefined
  if (page && info.bounds) {
    try {
      const owner = WebViews.nativeOwner(await st.ctx.hierarchy(), info.bounds)
      ownerText = owner ? WebViews.describeOwner(owner) : undefined
    } catch {
      ownerText = undefined
    }
  }
  const listing: Listing = { views: viewsDto(st), currentId: info.id, status: { text: '', error: false }, tree: undefined, owner: '' }
  if (my !== st.treeGen) return undefined
  st.nodes = new Map()
  if (failure !== undefined) {
    st.page = undefined
    // One automatic re-list per user action; a second "not found" is shown as is instead of looping.
    if (WebViews.isNotFound(failure) && !retried) {
      const again = await refresh(st, true)
      return again && { ...again, stale: true }
    }
    listing.status = { text: WebViews.describeError(failure), error: true }
  } else if (page) {
    st.page = page
    listing.tree = treeDto(st, page.root)
    listing.status = { text: `DOM of ${info.title.trim() ? info.title : info.url}: ${page.note}${page.truncated ? '. Larger pages are cut so the tab stays fast.' : ''}`, error: false }
  }
  const b = info.bounds
  listing.owner = !b
    ? ''
    : ownerText !== undefined
      ? `Native element: ${ownerText}`
      : `Web view bounds ${b.x},${b.y} ${b.width}x${b.height}` +
        (st.ctx.device.platform === 'IOS' ? ' (points); the native tree has no web view node, so only the bounds are known' : '; no native element with the same bounds found')
  return listing
}

/** `refresh` of the Kotlin panel: lists the web views of the foreground app and loads the DOM of the one to show. */
async function refresh(st: State, retried: boolean): Promise<Listing | undefined> {
  const dev = st.ctx.device
  const my = ++st.listGen
  let list: WebViewInfo[] | undefined
  let failure: string | undefined
  try {
    list = WebViews.parseList(await st.ctx.services.mobilecliCall(dev, ['webview', 'list']))
  } catch (e) {
    failure = msg(e, 'webview list failed')
  }
  if (my !== st.listGen) return undefined
  if (failure !== undefined || !list) {
    st.webViews = []
    st.current = undefined
    st.treeGen++
    st.page = undefined
    st.nodes = new Map()
    return { views: [], currentId: undefined, status: { text: WebViews.describeError(failure ?? 'webview list failed'), error: true }, tree: undefined, owner: '' }
  }
  const previous = st.current
  st.webViews = list
  // Ids change when the screen is re-entered, so a web view is recognised by url, title and app.
  const pick =
    list.find((w) => previous !== undefined && w.url === previous.url && w.title === previous.title && w.bundleId === previous.bundleId) ?? list.find((w) => w.visible) ?? list[0]
  st.current = pick
  if (!pick) {
    st.treeGen++
    st.page = undefined
    st.nodes = new Map()
    return {
      views: [],
      currentId: undefined,
      status: { text: 'No web view in the foreground app. Open a screen that shows one (debug builds only), then press Refresh.', error: false },
      tree: undefined,
      owner: '',
    }
  }
  // The Kotlin status line shows the DOM result last; the count of web views stays in the combo.
  return loadDom(st, retried)
}

async function select(st: State, key: string): Promise<unknown> {
  const my = ++st.selGen
  clearHighlight(st)
  const node = st.nodes.get(key)
  st.selected = node
  const page = st.page
  if (!node || !page) return undefined
  const css = WebLocators.cssSelector(node, page.root)
  const xp = WebLocators.xpath(node, page.root)
  const attrs: Array<[string, string]> = []
  if (node.text.length > 0) attrs.push(['(own text)', node.text])
  for (const [k, v] of node.attributes) attrs.push([k, v])
  const dev = st.ctx.device
  const info = st.current
  if (info) {
    void (async () => {
      let live: LiveCheck | undefined
      let failure: string | undefined
      try {
        // One eval for both counts and the current rect (the page may have scrolled since the DOM was loaded).
        live = LiveCheck.parse(await st.ctx.services.mobilecliCall(dev, WebViewEval.args(info.id, LiveCheck.script(css.value, xp.value, node.path))))
      } catch (e) {
        failure = msg(e, '')
      }
      if (my !== st.selGen) return
      if (failure !== undefined || !live) {
        st.ctx.emit('live', { seq: my, failed: 'Live check failed: ' + WebViews.describeError(failure ?? '') })
        return
      }
      const b = info.bounds
      const rect: Rect | undefined = live.rect && b ? WebRectMapper.toDevice(live.rect, live.viewportWidth, b) : undefined
      const shown = rect && b ? WebRectMapper.clip(rect, b) : rect
      let note: string
      if (rect && !shown) {
        note = 'The element is outside the visible part of the web view'
      } else if (shown && st.visible) {
        st.ctx.highlight([shown])
        st.highlighted = true
        note = `Highlighted on the mirror: ${shown.x},${shown.y} ${shown.width}x${shown.height}`
      } else {
        note = !live.rect ? 'The element is no longer in the page' : 'Not shown on the mirror (the element has no size, so it is not rendered)'
      }
      st.ctx.emit('live', {
        seq: my,
        cssCount: live.cssCount,
        cssError: live.cssError,
        xpathCount: live.xpathCount,
        xpathError: live.xpathError,
        cssText: matchText(live.cssCount, live.cssError),
        xpathText: matchText(live.xpathCount, live.xpathError),
        note,
      })
    })()
  }
  return {
    seq: my,
    css: css.value,
    xpath: xp.value,
    // The live count is the page's own answer; before it arrives the count in the loaded DOM is shown.
    cssCount: css.domCount,
    xpathCount: xp.domCount,
    cssText: `${matchText(css.domCount)} in the loaded DOM`,
    xpathText: `${matchText(xp.domCount)} in the loaded DOM`,
    attrs,
  }
}

export const webviewHost: ToolHost = {
  id: 'webview',
  title: 'WebView',

  async handle(method, params, ctx) {
    const st = stateOf(ctx)
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'refresh':
        st.visible = true
        return refresh(st, false)
      case 'loadDom': {
        const info = st.webViews.find((w) => w.id === p.id)
        if (info) st.current = info
        return loadDom(st, false)
      }
      case 'select':
        st.visible = true
        return select(st, String(p.key ?? ''))
      case 'run': {
        const info = st.current
        const code = String(p.code ?? '')
        if (!info || code.trim() === '') return undefined
        const my = ++st.evalGen
        let outcome
        try {
          outcome = WebViewEval.format(await ctx.services.mobilecliCall(ctx.device, WebViewEval.args(info.id, code)))
        } catch (e) {
          outcome = WebViewEval.formatError(msg(e, 'webview eval failed'))
        }
        if (my !== st.evalGen) return undefined
        return { ...outcome, notFound: outcome.error && WebViews.isNotFound(outcome.text) }
      }
      default:
        throw new Error(`WebView: unknown method ${method}`)
    }
  },

  shown(ctx) {
    stateOf(ctx).visible = true
  },

  hidden(ctx) {
    const st = stateOf(ctx)
    st.visible = false
    clearHighlight(st)
  },

  dispose(ctx) {
    const st = stateOf(ctx)
    st.listGen++
    st.treeGen++
    st.selGen++
    st.evalGen++
    clearHighlight(st)
    states.delete(ctx.device)
  },
}
