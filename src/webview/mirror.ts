// ported-from: ui/ScreenView.kt
// ported-from: ui/InspectorPanel.kt
// ported-from: ui/DeviceToolsPanel.kt
// The viewer page: mirror canvas with input, inspector tree and properties, and the Device Tools tab strip.
import { Gestures } from '../core/input/gestures'
import { HierarchyQueries, UiNode } from '../core/inspector/uiNode'
import { size, type Rect, type Size } from '../core/model'
import { ScreenGeometry } from '../core/screenGeometry'
import type { Capabilities, DeviceInfoDto, HardwareKey, NodeDto, ToHost, ToWebview } from '../protocol'
import type { ToolApi, ToolView } from './toolApi'
import { toolViews } from './tools'
import { injectToolStyles } from './ui'

declare function acquireVsCodeApi(): { postMessage(message: ToHost): void }
const vscode = acquireVsCodeApi()
const send = (m: ToHost): void => vscode.postMessage(m)

// ---------------------------------------------------------------- state
let device: DeviceInfoDto | undefined
let caps: Capabilities | undefined
let bitmap: ImageBitmap | undefined
let frameSize: Size | undefined
let root: UiNode | undefined
let selected: UiNode | undefined
let hovered: UiNode | undefined
let inspecting = false
let toolHighlight: Rect[] = []
let nextRequest = 1
const pendingHierarchy = new Map<number, (m: Extract<ToWebview, { type: 'hierarchy' }>) => void>()
const pendingTool = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const toolListeners = new Map<string, Map<string, Set<(d: unknown) => void>>>()

// ---------------------------------------------------------------- layout
const app = document.getElementById('app')!
app.innerHTML = `
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
  #app { display: grid; grid-template-columns: minmax(220px, 40%) 1fr; grid-template-rows: auto 1fr minmax(120px, 38%); height: 100vh; }
  #toolbar { grid-column: 1 / 3; display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #title { font-weight: 600; margin-right: 8px; }
  #statusline { margin-left: auto; opacity: .8; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #statusline.error { color: var(--vscode-errorForeground); opacity: 1; }
  #screen { position: relative; min-width: 0; min-height: 0; grid-row: 2 / 4; }
  canvas { width: 100%; height: 100%; display: block; outline: none; cursor: crosshair; }
  #side { display: grid; grid-template-rows: 1fr auto; min-width: 0; min-height: 0; border-left: 1px solid var(--vscode-panel-border); }
  #tree { overflow: auto; padding: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .row { white-space: pre; cursor: pointer; padding: 0 2px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #props { max-height: 35%; overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
  #props table { border-collapse: collapse; } #props td { padding: 1px 8px 1px 0; vertical-align: top; } #props td:first-child { opacity: .7; white-space: nowrap; }
  #tools { grid-column: 2; border-top: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; min-height: 0; }
  #tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); }
  #tabs button { background: transparent; color: var(--vscode-foreground); border-radius: 0; border-bottom: 2px solid transparent; white-space: nowrap; }
  #tabs button.on { border-bottom-color: var(--vscode-focusBorder); }
  #tabbody { flex: 1; overflow: auto; min-height: 0; }
  .tab { display: none; padding: 6px; } .tab.on { display: block; }
</style>
<div id="toolbar"></div>
<div id="screen"><canvas id="canvas" tabindex="0"></canvas></div>
<div id="side"><div id="tree">Connect a device, then press Inspect.</div><div id="props"></div></div>
<div id="tools"><div id="tabs"></div><div id="tabbody"></div></div>`

injectToolStyles()
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('canvas')
const ctx2d = canvas.getContext('2d')!

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.title = title
  b.onclick = onClick
  return b
}

// ---------------------------------------------------------------- toolbar
const toolbar = $('toolbar')
const titleEl = document.createElement('span')
titleEl.id = 'title'
const statusEl = document.createElement('span')
statusEl.id = 'statusline'
const key = (k: HardwareKey) => () => send({ type: 'key', key: k })
const inspectBtn = button('Inspect', 'Capture the UI hierarchy and pick elements on the screen', () => {
  inspecting = !inspecting
  inspectBtn.classList.toggle('on', inspecting)
  if (inspecting) void refreshHierarchy()
  draw()
})
toolbar.append(
  titleEl,
  button('Home', 'Home', key('HOME')),
  button('Back', 'Back', key('BACK')),
  button('Recents', 'App switcher', key('APP_SWITCH')),
  button('Vol+', 'Volume up', key('VOLUME_UP')),
  button('Vol−', 'Volume down', key('VOLUME_DOWN')),
  button('Power', 'Power', key('POWER')),
  inspectBtn,
  button('Refresh tree', 'Capture the hierarchy again', () => void refreshHierarchy()),
  statusEl,
)

function setStatus(message: string, level: 'info' | 'error' = 'info'): void {
  statusEl.textContent = message
  statusEl.className = level === 'error' ? 'error' : ''
  statusEl.title = caps?.transportTooltip ?? message
}

// ---------------------------------------------------------------- drawing
function geometry(): ScreenGeometry | undefined {
  if (!frameSize) return undefined
  const f = caps?.upright ? size(frameSize.height, frameSize.width) : frameSize
  return new ScreenGeometry(size(canvas.clientWidth, canvas.clientHeight), f)
}

function logical(): Size | undefined {
  return caps?.logicalSize ?? (frameSize ? (caps?.upright ? size(frameSize.height, frameSize.width) : frameSize) : undefined)
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
}

function draw(): void {
  resizeCanvas()
  const dpr = window.devicePixelRatio || 1
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
  const g = geometry()
  if (!g || !bitmap) return
  const r = g.imageRect
  if (caps?.upright) {
    // The simulator's portrait framebuffer holds the landscape picture rotated 90 degrees clockwise: turn it back.
    ctx2d.save()
    ctx2d.translate(r.x, r.y + r.height)
    ctx2d.rotate(-Math.PI / 2)
    ctx2d.drawImage(bitmap, 0, 0, r.height, r.width)
    ctx2d.restore()
  } else {
    ctx2d.drawImage(bitmap, r.x, r.y, r.width, r.height)
  }
  const lg = logical()
  if (!lg) return
  const box = (b: Rect, color: string, fill: string) => {
    const p = g.logicalToPanel(b, lg)
    ctx2d.fillStyle = fill
    ctx2d.fillRect(p.x, p.y, p.width, p.height)
    ctx2d.strokeStyle = color
    ctx2d.lineWidth = 2
    ctx2d.strokeRect(p.x, p.y, p.width, p.height)
  }
  if (inspecting && hovered?.bounds && hovered !== selected) box(hovered.bounds, '#4da3ff', 'rgba(77,163,255,.15)')
  if (selected?.bounds) box(selected.bounds, '#ff9f1a', 'rgba(255,159,26,.2)')
  for (const b of toolHighlight) box(b, '#e5484d', 'rgba(229,72,77,.18)')
}

new ResizeObserver(draw).observe(canvas)

// ---------------------------------------------------------------- input (mouse rules: core/input/gestures)
let down: { x: number; y: number; alt: boolean; time: number; lp?: ReturnType<typeof setTimeout>; longFired: boolean; lx?: number; ly?: number } | undefined

function pointer(e: MouseEvent): { px: number; py: number } {
  const rc = canvas.getBoundingClientRect()
  return { px: e.clientX - rc.left, py: e.clientY - rc.top }
}

function toLogical(px: number, py: number): [number, number] | undefined {
  const g = geometry()
  const lg = logical()
  return g && lg ? g.panelToLogical(px, py, lg) : undefined
}

canvas.addEventListener('mousedown', (e) => {
  canvas.focus()
  if (e.button !== 0) return
  const { px, py } = pointer(e)
  if (inspecting) return pick(px, py)
  const l = toLogical(px, py)
  if (!l) return
  down = { x: px, y: py, alt: e.altKey, time: Date.now(), longFired: false, lx: l[0], ly: l[1] }
  const d = down
  d.lp = setTimeout(() => {
    d.longFired = true
    send({ type: 'longPress', x: l[0], y: l[1], durationMs: caps?.longPressMs ?? Gestures.LONG_PRESS_MS })
  }, caps?.longPressMs ?? Gestures.LONG_PRESS_MS)
})

canvas.addEventListener('mousemove', (e) => {
  const { px, py } = pointer(e)
  if (down && Gestures.movedBeyondSlop(px - down.x, py - down.y, 6) && down.lp) {
    clearTimeout(down.lp)
    down.lp = undefined
  }
  if (inspecting) {
    const l = toLogical(px, py)
    const next = root && l ? HierarchyQueries.deepestAt(root, l[0], l[1]) : undefined
    if (next !== hovered) {
      hovered = next
      draw()
    }
  }
})

window.addEventListener('mouseup', (e) => {
  const d = down
  down = undefined
  if (!d || e.button !== 0) return
  if (d.lp) clearTimeout(d.lp)
  const { px, py } = pointer(e)
  const moved = Gestures.movedBeyondSlop(px - d.x, py - d.y, 6)
  const from = [d.lx!, d.ly!] as const
  const to = toLogical(px, py)
  const release = Gestures.onRelease(d.longFired, moved, d.alt, e.detail)
  switch (release) {
    case 'CONSUMED':
      break
    case 'TAP':
      send({ type: 'tap', x: from[0], y: from[1] })
      break
    case 'DOUBLE_TAP':
      // Without a fast transport two taps are not a double tap: fall back to a tap, like DeviceViewerPanel.
      send(caps?.supportsDoubleTap ? { type: 'doubleTap', x: from[0], y: from[1] } : { type: 'tap', x: from[0], y: from[1] })
      break
    case 'SWIPE':
    case 'HOLD_DRAG':
      if (!to) break
      if (release === 'HOLD_DRAG' && caps?.supportsHoldDrag) send({ type: 'dragWithHold', fromX: from[0], fromY: from[1], toX: to[0], toY: to[1], holdMs: Gestures.HOLD_DRAG_MS })
      else send({ type: 'swipe', fromX: from[0], fromY: from[1], toX: to[0], toY: to[1] })
      break
  }
})

canvas.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return
  const special: Record<string, HardwareKey> = { Enter: 'ENTER', Backspace: 'DELETE', Escape: 'BACK' }
  if (special[e.key]) {
    e.preventDefault()
    send({ type: 'key', key: special[e.key] })
  } else if (e.key.length === 1) {
    e.preventDefault()
    send({ type: 'text', text: e.key })
  }
})

canvas.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')
  if (text) send({ type: 'text', text })
})

// ---------------------------------------------------------------- inspector
const treeEl = $('tree')
const propsEl = $('props')
const rowOf = new Map<UiNode, HTMLElement>()

async function refreshHierarchy(): Promise<void> {
  const requestId = nextRequest++
  setStatus('Capturing the hierarchy...')
  const reply = await new Promise<Extract<ToWebview, { type: 'hierarchy' }>>((resolve) => {
    pendingHierarchy.set(requestId, resolve)
    send({ type: 'hierarchy', requestId })
  })
  if (reply.error || !reply.root) return setStatus(reply.error ?? 'No hierarchy', 'error')
  root = buildTree(reply.root)
  selected = undefined
  hovered = undefined
  renderTree()
  renderProps()
  setStatus(`${[...root.walk()].length} elements`)
  draw()
}

function buildTree(dto: NodeDto): UiNode {
  const node = new UiNode(dto.platform, dto.rawType, dto.attributes, dto.bounds)
  for (const c of dto.children) node.addChild(buildTree(c))
  return node
}

function renderTree(): void {
  treeEl.textContent = ''
  rowOf.clear()
  if (!root) return
  const add = (n: UiNode) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.textContent = '  '.repeat(n.depth) + n.displayLabel()
    row.onclick = () => select(n)
    rowOf.set(n, row)
    treeEl.append(row)
    n.children.forEach(add)
  }
  add(root)
}

function select(n: UiNode | undefined): void {
  selected = n
  for (const [node, row] of rowOf) row.classList.toggle('sel', node === n)
  if (n) rowOf.get(n)?.scrollIntoView({ block: 'nearest' })
  renderProps()
  draw()
}

function pick(px: number, py: number): void {
  const l = toLogical(px, py)
  select(root && l ? HierarchyQueries.deepestAt(root, l[0], l[1]) : undefined)
}

function renderProps(): void {
  propsEl.textContent = ''
  const n = selected
  if (!n) return
  const table = document.createElement('table')
  const rows: Array<[string, string | undefined]> = [
    ['type', n.rawType],
    ['label', n.label],
    ['text', n.text],
    ['value', n.value],
    ['identifier', n.identifier],
    ['resource-id', n.resourceId],
    ['bounds', n.bounds ? `${n.bounds.x},${n.bounds.y} ${n.bounds.width}×${n.bounds.height}` : undefined],
    ['xpath', n.absoluteXPath()],
  ]
  for (const [k, v] of rows) {
    if (v === undefined) continue
    const tr = table.insertRow()
    tr.insertCell().textContent = k
    tr.insertCell().textContent = v
  }
  propsEl.append(table)
}

// ---------------------------------------------------------------- tools
const tabsEl = $('tabs')
const tabBody = $('tabbody')
const mounted = new Map<string, HTMLElement>()
let activeTool: ToolView | undefined

function apiFor(view: ToolView): ToolApi {
  return {
    get device() {
      return device
    },
    get capabilities() {
      return caps
    },
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const requestId = nextRequest++
        pendingTool.set(requestId, { resolve: resolve as (v: unknown) => void, reject })
        send({ type: 'tool', tool: view.id, requestId, method, params })
      }) as Promise<never>,
    on(event, handler) {
      const perTool = toolListeners.get(view.id) ?? new Map()
      toolListeners.set(view.id, perTool)
      const set = perTool.get(event) ?? new Set()
      perTool.set(event, set)
      set.add(handler)
      return () => set.delete(handler)
    },
    hierarchy: () => (root ? toDtoOf(root) : undefined),
    highlight: (b) => {
      toolHighlight = b
      draw()
    },
    status: setStatus,
  }
}

function toDtoOf(n: UiNode): NodeDto {
  return { platform: n.platform, rawType: n.rawType, attributes: { ...n.attributes }, bounds: n.bounds, children: n.children.map(toDtoOf) }
}

function showTool(view: ToolView): void {
  if (activeTool === view) return
  if (activeTool) {
    activeTool.hidden?.()
    send({ type: 'toolHidden', tool: activeTool.id })
    mounted.get(activeTool.id)?.classList.remove('on')
  }
  activeTool = view
  let el = mounted.get(view.id)
  if (!el) {
    el = document.createElement('div')
    el.className = 'tab'
    tabBody.append(el)
    mounted.set(view.id, el)
    try {
      view.mount(el, apiFor(view))
    } catch (e) {
      el.textContent = `${view.title} failed to start: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  el.classList.add('on')
  for (const b of Array.from(tabsEl.children)) b.classList.toggle('on', (b as HTMLElement).dataset.id === view.id)
  view.shown?.()
  send({ type: 'toolShown', tool: view.id })
}

for (const view of toolViews) {
  const b = button(view.title, view.title, () => showTool(view))
  b.dataset.id = view.id
  tabsEl.append(b)
}
if (toolViews.length) showTool(toolViews[0])
else $('tools').style.display = 'none'

// ---------------------------------------------------------------- host messages
window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data
  switch (m.type) {
    case 'device':
      device = m.device
      titleEl.textContent = m.device.displayName
      toolViews.forEach((v) => v.deviceChanged?.(device))
      break
    case 'capabilities':
      caps = m.capabilities
      draw()
      break
    case 'status':
      setStatus(m.message, m.level)
      break
    case 'frame': {
      frameSize = size(m.width, m.height)
      const bytes = Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0))
      void createImageBitmap(new Blob([bytes], { type: m.mime })).then((bmp) => {
        bitmap?.close()
        bitmap = bmp
        draw()
      })
      break
    }
    case 'hierarchy':
      pendingHierarchy.get(m.requestId)?.(m)
      pendingHierarchy.delete(m.requestId)
      break
    case 'toolResult': {
      const p = pendingTool.get(m.requestId)
      pendingTool.delete(m.requestId)
      if (m.ok) p?.resolve(m.result)
      else p?.reject(new Error(m.error ?? 'Failed'))
      break
    }
    case 'toolEvent':
      toolListeners.get(m.tool)?.get(m.event)?.forEach((h) => h(m.data))
      break
    case 'highlight':
      toolHighlight = m.bounds
      draw()
      break
  }
})

send({ type: 'ready' })
