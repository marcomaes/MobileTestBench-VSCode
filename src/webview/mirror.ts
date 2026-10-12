// ported-from: ui/ScreenView.kt
// ported-from: ui/DeviceViewerPanel.kt
// ported-from: ui/DeviceToolsPanel.kt
// The viewer page: toolbar, mirror canvas with input and overlays, the inspector (src/webview/inspector.ts), the Device Tools tab
// strip, the hover and status lines. The host half is src/extension/deviceViewer.ts; everything the host owns (session, reconnect,
// Device Power, freeze capture, project state, foreground app) arrives as messages (src/protocol.ts).
import { CoordinateMapper, CoordinateText, ElementInfo, GridSteps, type HoverPoint } from '../core/coords/coordinates'
import { Gestures } from '../core/input/gestures'
import { HierarchyQueries, type UiNode } from '../core/inspector/uiNode'
import { size, type Rect, type Size } from '../core/model'
import type { PowerAction } from '../core/power/devicePower'
import { ProjectLayout, type LayoutPatch } from '../core/project/projectLayout'
import { ScreenGeometry } from '../core/screenGeometry'
import type { Capabilities, DeviceInfoDto, HardwareKey, OrientationName, ToHost, ToWebview } from '../protocol'
import { createInspector, inspectorCss, nodeFromDto, nodeToDto } from './inspector'
import { LocatorGenerator } from '../core/inspector/locators'
import { LocatorCode, LocatorLanguage } from '../core/pageobject/locatorCode'
import type { ToolApi, ToolView } from './toolApi'
import { toolViews } from './tools'
import { injectToolStyles } from './ui'

declare function acquireVsCodeApi(): { postMessage(message: ToHost): void }
const vscode = acquireVsCodeApi()
const send = (m: ToHost): void => vscode.postMessage(m)

/** Pause after the last input before the inspector re-reads the hierarchy. */
const AUTO_REFRESH_DELAY_MS = 700
const CUE_MS = 450
const TAP_MARK_MS = 900
/** Slop in CSS pixels before a press counts as a drag (the Kotlin JBUI.scale(8)). */
const SLOP = 8
/** A status the host marks as an error stays this long before the fps line takes over again. */
const ERROR_HOLD_MS = 4_000

// ---------------------------------------------------------------- state
let device: DeviceInfoDto | undefined
let caps: Capabilities | undefined
let connected = false
let bitmap: ImageBitmap | undefined
let frameSize: Size | undefined
let frameSeq = 0
let frameApplied = 0
let frameCount = 0
let placeholder = 'Connecting...'
let inspecting = false
/** The recorder is recording: clicks reach the device even while inspecting. */
let recording = false
/** Set while the recorder waits for an element to assert on: a click picks instead of acting on the device. */
let picker: ((x: number, y: number) => void) | undefined
let copyLanguage = LocatorLanguage.AS_SHOWN
let copyWholeLine = false
let frozen = false
let gridVisible = false
let saveHierarchy = false
let powerBusy = false
let powerAvailable: PowerAction[] = []
let orientation: OrientationName | undefined
let orientationBusy = false
let screenRecording = false
let tracking = false
let statusHoldUntil = 0
let locatorHighlight = false
let toolHighlight: Rect[] = []
let matchBounds: Rect[] = []
let issueBounds: Rect[] = []
let selectedBounds: Rect | undefined
let hoverBounds: Rect | undefined
let hoverPoint: HoverPoint | undefined
let hoverPanel: { x: number; y: number } | undefined
let hoverReported: HoverPoint | undefined
let tapMark: { x: number; y: number } | undefined
let cue: { x: number; y: number } | undefined
let foreground: { copyText?: string } = {}
let nextRequest = 1
let refreshInFlight = false
let refreshAgain = false
let autoRefresh: ReturnType<typeof setTimeout> | undefined
let tapTimer: ReturnType<typeof setTimeout> | undefined
let cueTimer: ReturnType<typeof setTimeout> | undefined
let mirrorProportion = ProjectLayout.DEFAULT_MIRROR
let toolsProportion = ProjectLayout.DEFAULT_TOOLS
let toolsOpen = false
const pendingHierarchy = new Map<number, (m: Extract<ToWebview, { type: 'hierarchy' }>) => void>()
const pendingTool = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const toolListeners = new Map<string, Map<string, Set<(d: unknown) => void>>>()

// ---------------------------------------------------------------- layout
const app = document.getElementById('app')!
app.innerHTML = `
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100vh; }
  #toolbar { display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; flex: none; }
  #toolbar .sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border); margin: 0 2px; }
  #toolbar button, #tabs button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; border-radius: 2px; cursor: pointer; }
  #toolbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  #toolbar button:disabled { opacity: .45; cursor: default; }
  #toolbar button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #title { font-weight: 600; margin-right: 8px; }
  #work { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #main { display: flex; min-height: 0; min-width: 0; flex: 1 1 0; overflow: hidden; }
  #screen { position: relative; min-width: 0; min-height: 0; flex: 1 1 0; }
  canvas { width: 100%; height: 100%; display: block; outline: none; cursor: default; }
  canvas.inspect { cursor: crosshair; }
  #side { display: none; min-width: 0; min-height: 0; flex: 1 1 0; border-left: 1px solid var(--vscode-panel-border); }
  #side.on { display: flex; flex-direction: column; overflow: hidden; }
  #side .mtb-inspector { flex: 1; height: auto; }
  .split { flex: none; background: var(--vscode-panel-border); }
  .split.v { width: 4px; cursor: col-resize; display: none; } .split.h { height: 4px; cursor: row-resize; display: none; }
  .split:hover { background: var(--vscode-focusBorder); }
  #tools { display: none; flex-direction: column; min-height: 0; flex: 1 1 0; border-top: 1px solid var(--vscode-panel-border); }
  #tools.on { display: flex; }
  #tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
  #tabs button { background: transparent; color: var(--vscode-foreground); border-radius: 0; border-bottom: 2px solid transparent; white-space: nowrap; }
  #tabs button.on { border-bottom-color: var(--vscode-focusBorder); }
  #tabbody { flex: 1; overflow: auto; min-height: 0; }
  .tab { display: none; padding: 6px; } .tab.on { display: block; }
  #infobar { display: flex; justify-content: space-between; gap: 12px; padding: 2px 8px; flex: none; border-top: 1px solid var(--vscode-panel-border); }
  #hover { opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.3em; }
  #foreground { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .8; display: none; max-width: 45%; }
  #statusbar { display: flex; gap: 12px; padding: 2px 8px; flex: none; align-items: baseline; }
  #statusline { opacity: .85; white-space: pre-wrap; word-break: break-word; flex: 1; }
  #statusline.error { color: var(--vscode-errorForeground); opacity: 1; }
  #cancel { display: none; background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; text-decoration: underline; }
  .popup { position: fixed; z-index: 20; min-width: 180px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px rgba(0,0,0,.35); padding: 3px 0; }
  .popup div { padding: 3px 14px; cursor: pointer; white-space: nowrap; }
  .popup div:hover:not(.disabled) { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
  .popup div.disabled { opacity: .45; cursor: default; }
  .popup hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 3px 0; }
  ${inspectorCss}
</style>
<div id="toolbar"></div>
<div id="work">
  <div id="main">
    <div id="screen"><canvas id="canvas" tabindex="0"></canvas></div>
    <div class="split v" id="splitv"></div>
    <div id="side"></div>
  </div>
  <div class="split h" id="splith"></div>
  <div id="tools"><div id="tabs"></div><div id="tabbody"></div></div>
</div>
<div id="infobar"><div id="hover" style="visibility:hidden"> </div><div id="foreground"></div></div>
<div id="statusbar"><div id="statusline">Not connected</div><button id="cancel">Cancel</button></div>`

injectToolStyles()
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('canvas')
const ctx2d = canvas.getContext('2d')!
const mainEl = $('main')
const screenEl = $('screen')
const sideEl = $('side')
const splitV = $('splitv')
const splitH = $('splith')
const toolsEl = $('tools')
const hoverEl = $('hover')
const foregroundEl = $('foreground')
const statusEl = $('statusline')
const cancelEl = $<HTMLButtonElement>('cancel')

let filterSaveTimer: ReturnType<typeof setTimeout> | undefined
const inspector = createInspector(sideEl, {
  onFilterChange: (text) => {
    // The setting is written once the user stopped typing.
    if (filterSaveTimer) clearTimeout(filterSaveTimer)
    filterSaveTimer = setTimeout(() => send({ type: 'elementFilter', text }), 600)
  },
  onContextMenu: (node, x, y) => {
    const root = inspector.root()
    const items: MenuItem[] = []
    if (root && !node.isRoot) {
      for (const suggestion of LocatorGenerator.suggest(node, root)) {
        items.push({ label: LocatorCode.menuLabel(suggestion, copyLanguage), run: () => send({ type: 'copyText', text: LocatorCode.textFor(suggestion, copyLanguage, copyWholeLine).text }) })
      }
      items.push('sep')
    }
    const props: Array<[string, string]> = [['type', node.rawType]]
    if (node.bounds) props.push(['bounds', `x=${node.bounds.x} y=${node.bounds.y} w=${node.bounds.width} h=${node.bounds.height}`])
    props.push(['xpath', node.absoluteXPath()], ...Object.entries(node.attributes))
    items.push({ label: 'Copy All Properties', run: () => send({ type: 'copyText', text: props.map(([k, v]) => `${k}=${v}`).join('\n') }) })
    popup(undefined, items, { x, y })
  },
  onSelect: (node) => {
    selectedBounds = node?.bounds
    draw()
    refreshButtons()
  },
  setMatchBounds: (rects) => {
    matchBounds = rects
    draw()
  },
  setIssueBounds: (rects) => {
    issueBounds = rects
    draw()
  },
})

// ---------------------------------------------------------------- toolbar
const toolbar = $('toolbar')
const titleEl = document.createElement('span')
titleEl.id = 'title'

function button(label: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.title = title
  b.onclick = onClick
  return b
}
const sep = (): HTMLElement => Object.assign(document.createElement('span'), { className: 'sep' })
const key = (k: HardwareKey) => () => interact({ type: 'key', key: k })

const refreshDevicesBtn = button('Refresh', 'Refresh Devices', () => send({ type: 'refreshDevices' }))
const connectBtn = button('Connect', 'Connect to the device', () => send({ type: 'connect' }))
const disconnectBtn = button('Disconnect', 'Disconnect (and stop waiting for the device)', () => send({ type: 'disconnect' }))
const powerBtn = button('Device Power ▾', 'Boot, shut down or reboot the emulator or simulator', (e) => {
  const labels: Record<PowerAction, string> = { BOOT: 'Boot', SHUTDOWN: 'Shut Down', REBOOT: 'Reboot' }
  popup(
    e.currentTarget as HTMLElement,
    (['BOOT', 'SHUTDOWN', 'REBOOT'] as PowerAction[]).map((a) => ({ label: labels[a], enabled: !powerBusy && powerAvailable.includes(a), run: () => send({ type: 'power', action: a }) })),
  )
})
const backBtn = button('Back', 'Back', key('BACK'))
const homeBtn = button('Home', 'Home', key('HOME'))
const recentsBtn = button('Recents', 'Recent apps', key('APP_SWITCH'))
const typeBtn = button('Type…', 'Type text on the device', () => interact({ type: 'promptText' }))
const rotateBtn = button('Landscape', 'Rotate the device', () => send({ type: 'rotate' }))
const inspectBtn = button('Inspect', 'Show the element tree and locators', () => setInspect(!inspecting))
const refreshTreeBtn = button('Refresh tree', 'Capture the hierarchy again', () => void refreshHierarchy())
const freezeBtn = button('Freeze', 'Freeze the screen to inspect a transient state; input is blocked while frozen', () => setFrozen(!frozen))
const gridBtn = button('Grid', 'Show a coordinate grid and a crosshair with the cursor position over the screen', () => {
  gridVisible = !gridVisible
  send({ type: 'showGrid', on: gridVisible })
  refreshButtons()
  draw()
})
const toolsBtn = button('Device Tools', 'Device tools: log, apps, open URL, crashes, location, display, input, network, biometrics', () => setToolsOpen(!toolsOpen))
const screenshotBtn = button('Screenshot ▾', 'Copy or save the current frame', (e) => {
  const outline = selectedBounds
  popup(e.currentTarget as HTMLElement, [
    { label: 'Copy to Clipboard', run: () => send({ type: 'screenshot', action: 'copy' }) },
    { label: 'Save as PNG...', run: () => send({ type: 'screenshot', action: 'save' }) },
    ...(outline
      ? [
          { label: 'Copy to Clipboard, selected element outlined', run: () => send({ type: 'screenshot', action: 'copy', outline }) },
          { label: 'Save as PNG, selected element outlined...', run: () => send({ type: 'screenshot', action: 'save', outline }) },
        ]
      : []),
    'sep' as const,
    {
      label: (saveHierarchy ? '[x] ' : '[ ] ') + 'Also save the hierarchy (XML) next to the PNG',
      run: () => {
        saveHierarchy = !saveHierarchy
        send({ type: 'saveHierarchyWithScreenshot', on: saveHierarchy })
      },
    },
  ])
})
const recordBtn = button('Record screen', 'Record the device screen to an MP4 file (needs mobilecli)', () => send({ type: 'screenRecord', on: !screenRecording }))
const settingsBtn = button('Settings', 'Open the Mobile Test Bench settings', () => send({ type: 'openSettings' }))
toolbar.append(
  titleEl,
  refreshDevicesBtn,
  connectBtn,
  disconnectBtn,
  powerBtn,
  sep(),
  backBtn,
  homeBtn,
  recentsBtn,
  typeBtn,
  rotateBtn,
  sep(),
  inspectBtn,
  refreshTreeBtn,
  freezeBtn,
  gridBtn,
  toolsBtn,
  sep(),
  screenshotBtn,
  recordBtn,
  settingsBtn,
)

/** Enables, hides and highlights the toolbar buttons from the state (the Kotlin action `update` methods). */
function refreshButtons(): void {
  const hasInput = connected && caps?.supportsInput !== false
  connectBtn.disabled = connected || !device
  disconnectBtn.disabled = !connected && cancelEl.style.display !== 'inline'
  powerBtn.disabled = powerBusy || powerAvailable.length === 0
  const ios = device?.platform === 'IOS'
  backBtn.style.display = recentsBtn.style.display = ios ? 'none' : ''
  for (const b of [backBtn, homeBtn, recentsBtn, typeBtn]) b.disabled = !hasInput
  rotateBtn.disabled = !connected || orientationBusy
  rotateBtn.classList.toggle('on', orientation === 'landscape')
  rotateBtn.title = orientation === 'landscape' ? 'Rotate to portrait (current: landscape)' : orientation === 'portrait' ? 'Rotate to landscape (current: portrait)' : 'Rotate the device (needs mobilecli)'
  inspectBtn.classList.toggle('on', inspecting)
  refreshTreeBtn.disabled = !inspecting || !connected || frozen
  freezeBtn.classList.toggle('on', frozen)
  freezeBtn.disabled = !frozen && !(connected && bitmap)
  gridBtn.classList.toggle('on', gridVisible)
  toolsBtn.classList.toggle('on', toolsOpen)
  screenshotBtn.disabled = !connected || !bitmap
  recordBtn.classList.toggle('on', screenRecording)
  recordBtn.textContent = screenRecording ? 'Stop recording' : 'Record screen'
  recordBtn.disabled = !screenRecording && !connected
  canvas.classList.toggle('inspect', inspectMode())
}

// ---------------------------------------------------------------- popup menu
type MenuItem = { label: string; enabled?: boolean; run: () => void } | 'sep'
let closePopup: (() => void) | undefined

/** A small menu under [anchor] (or at [at]); closes on a click elsewhere or Escape. */
function popup(anchor: HTMLElement | undefined, items: MenuItem[], at?: { x: number; y: number }): void {
  closePopup?.()
  const menu = document.createElement('div')
  menu.className = 'popup'
  for (const item of items) {
    if (item === 'sep') {
      menu.append(document.createElement('hr'))
      continue
    }
    const row = document.createElement('div')
    row.textContent = item.label
    if (item.enabled === false) row.className = 'disabled'
    else
      row.onclick = () => {
        closePopup?.()
        item.run()
      }
    menu.append(row)
  }
  document.body.append(menu)
  const r = anchor?.getBoundingClientRect()
  const x = at?.x ?? r?.left ?? 0
  const y = at?.y ?? r?.bottom ?? 0
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`
  const onDown = (e: Event): void => {
    if (!menu.contains(e.target as Node)) closePopup?.()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closePopup?.()
  }
  setTimeout(() => window.addEventListener('mousedown', onDown), 0)
  window.addEventListener('keydown', onKey)
  closePopup = () => {
    window.removeEventListener('mousedown', onDown)
    window.removeEventListener('keydown', onKey)
    menu.remove()
    closePopup = undefined
  }
}

// ---------------------------------------------------------------- status and hover lines
function setStatus(message: string, level: 'info' | 'error' = 'info', holdMs?: number): void {
  statusEl.textContent = message
  statusEl.className = level === 'error' ? 'error' : ''
  statusEl.title = caps?.transportTooltip ?? ''
  const hold = holdMs ?? (level === 'error' ? ERROR_HOLD_MS : 0)
  statusHoldUntil = hold > 0 ? Date.now() + hold : 0
}

/** The fps line, once a second (the Kotlin `updateStatus`); a hold, a power operation or no session keeps the current text. */
setInterval(() => {
  const fps = frameCount
  frameCount = 0
  hoverEl.style.visibility = connected ? 'visible' : 'hidden'
  if (!connected || powerBusy || !device || Date.now() < statusHoldUntil) return
  const lg = logical()
  statusEl.className = ''
  statusEl.textContent = `${device.name}  |  ${caps?.transport ?? ''}  |  ` + (frozen ? 'frozen' : `${fps} fps`) + (lg ? `  |  ${lg.width}x${lg.height}` : '')
  statusEl.title = caps?.transportTooltip ?? ''
}, 1000)

/** The newest hierarchy known without asking the device (the inspector's, which is also the frozen one). */
const knownRoot = (): UiNode | undefined => inspector.root()

function showHover(point: HoverPoint | undefined): void {
  const root = knownRoot()
  const node = point && root ? HierarchyQueries.deepestAt(root, point.x, point.y) : undefined
  hoverEl.textContent = CoordinateText.infoLine(point, device?.platform, ElementInfo.of(node), root !== undefined)
}

cancelEl.onclick = () => send({ type: 'cancelReconnect' })
foregroundEl.onclick = () => {
  if (!foreground.copyText) return
  send({ type: 'copyText', text: foreground.copyText })
  setStatus(`Copied ${foreground.copyText}`, 'info', 2_000)
}

// ---------------------------------------------------------------- geometry and drawing
// A function declaration: createInspector fires onSelect during setup, before this point of the file runs.
function frameForGeometry(): Size | undefined {
  return frameSize ? (caps?.upright ? size(frameSize.height, frameSize.width) : frameSize) : undefined
}

function geometry(): ScreenGeometry | undefined {
  const f = frameForGeometry()
  return f ? new ScreenGeometry(size(canvas.clientWidth, canvas.clientHeight), f) : undefined
}

function logical(): Size | undefined {
  return caps?.logicalSize ?? frameForGeometry()
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

const COLORS = {
  selected: '#3574f0',
  match: '#208a3c',
  hover: '#e08855',
  web: '#d97706',
  issue: '#c7222d',
  cue: '#3574f0',
  tap: '#d93030',
  crosshair: 'rgba(217,48,48,.78)',
  grid: 'rgba(128,128,128,.55)',
  frozen: '#2f6fde',
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function drawLabel(text: string, x: number, baseline: number): void {
  const w = ctx2d.measureText(text).width
  ctx2d.fillStyle = 'rgba(0,0,0,.55)'
  ctx2d.fillRect(x - 1, baseline - 11, w + 2, 14)
  ctx2d.fillStyle = '#fff'
  ctx2d.fillText(text, x, baseline)
}

function drawPlaceholder(): void {
  const style = getComputedStyle(document.body)
  ctx2d.fillStyle = style.color
  ctx2d.globalAlpha = 0.6
  ctx2d.font = `${style.fontSize} ${style.fontFamily}`
  const lines: string[] = []
  // Wrap so a long message (a how-to, an error) stays readable in a narrow panel.
  for (const paragraph of placeholder.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`
      if (line !== '' && ctx2d.measureText(next).width > canvas.clientWidth - 32) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  const lh = 18
  let y = canvas.clientHeight / 2 - ((lines.length - 1) * lh) / 2
  ctx2d.textAlign = 'center'
  for (const line of lines) {
    ctx2d.fillText(line, canvas.clientWidth / 2, y)
    y += lh
  }
  ctx2d.textAlign = 'start'
  ctx2d.globalAlpha = 1
}

function draw(): void {
  resizeCanvas()
  const dpr = window.devicePixelRatio || 1
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
  const g = geometry()
  if (!g || !bitmap) return drawPlaceholder()
  const r = g.imageRect
  ctx2d.imageSmoothingQuality = 'high'
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
  const box = (b: Rect, color: string, fill: boolean): void => {
    const p = g.logicalToPanel(b, lg)
    if (fill) {
      ctx2d.fillStyle = rgba(color, 0.2)
      ctx2d.fillRect(p.x, p.y, p.width, p.height)
    }
    ctx2d.strokeStyle = color
    ctx2d.lineWidth = 2
    ctx2d.strokeRect(p.x, p.y, p.width, p.height)
  }
  for (const b of issueBounds) box(b, COLORS.issue, false)
  for (const b of matchBounds) box(b, COLORS.match, true)
  if (selectedBounds) box(selectedBounds, COLORS.selected, true)
  for (const b of toolHighlight) box(b, COLORS.web, true)
  if (hoverBounds) box(hoverBounds, COLORS.hover, false)
  if (cue) {
    ctx2d.beginPath()
    ctx2d.arc(cue.x, cue.y, 22, 0, Math.PI * 2)
    ctx2d.fillStyle = rgba(COLORS.cue, 0.24)
    ctx2d.fill()
    ctx2d.strokeStyle = COLORS.cue
    ctx2d.lineWidth = 2
    ctx2d.stroke()
  }
  if (gridVisible) drawGrid(g, lg)
  if (tapMark) drawTapMark(g, lg, tapMark)
  if (frozen) drawFrozenBadge(r)
}

function drawGrid(g: ScreenGeometry, lg: Size): void {
  const r = g.imageRect
  const step = GridSteps.choose(lg)
  ctx2d.save()
  ctx2d.beginPath()
  ctx2d.rect(r.x, r.y, r.width, r.height)
  ctx2d.clip()
  ctx2d.font = '10px ' + getComputedStyle(document.body).fontFamily
  ctx2d.lineWidth = 1
  ctx2d.strokeStyle = COLORS.grid
  for (const x of GridSteps.lines(lg.width, step)) {
    const px = r.x + Math.trunc((x * r.width) / lg.width) + 0.5
    ctx2d.beginPath()
    ctx2d.moveTo(px, r.y)
    ctx2d.lineTo(px, r.y + r.height)
    ctx2d.stroke()
    drawLabel(String(x), px + 2, r.y + 11)
  }
  for (const y of GridSteps.lines(lg.height, step)) {
    const py = r.y + Math.trunc((y * r.height) / lg.height) + 0.5
    ctx2d.beginPath()
    ctx2d.moveTo(r.x, py)
    ctx2d.lineTo(r.x + r.width, py)
    ctx2d.stroke()
    drawLabel(String(y), r.x + 2, py - 2)
  }
  const at = hoverPanel
  if (hoverPoint && at) {
    ctx2d.strokeStyle = COLORS.crosshair
    ctx2d.beginPath()
    ctx2d.moveTo(r.x, at.y + 0.5)
    ctx2d.lineTo(r.x + r.width, at.y + 0.5)
    ctx2d.moveTo(at.x + 0.5, r.y)
    ctx2d.lineTo(at.x + 0.5, r.y + r.height)
    ctx2d.stroke()
    const text = CoordinateText.crosshair(hoverPoint)
    const w = ctx2d.measureText(text).width + 6
    const tx = at.x + 10 + w > r.x + r.width ? at.x - 10 - w : at.x + 10
    const ty = at.y - 10 - 14 < r.y ? at.y + 10 + 14 : at.y - 10
    drawLabel(text, tx, ty)
  }
  ctx2d.restore()
}

function drawTapMark(g: ScreenGeometry, lg: Size, at: { x: number; y: number }): void {
  const [px, py] = g.logicalToPanelPoint(at.x, at.y, lg)
  const radius = 14
  ctx2d.strokeStyle = COLORS.tap
  ctx2d.fillStyle = COLORS.tap
  ctx2d.lineWidth = 2
  ctx2d.beginPath()
  ctx2d.arc(px, py, radius, 0, Math.PI * 2)
  ctx2d.stroke()
  ctx2d.beginPath()
  ctx2d.arc(px, py, 2, 0, Math.PI * 2)
  ctx2d.fill()
  ctx2d.font = '11px ' + getComputedStyle(document.body).fontFamily
  drawLabel(`${at.x}, ${at.y}`, px + radius + 3, py - radius / 2)
}

function drawFrozenBadge(image: Rect): void {
  ctx2d.font = 'bold 12px ' + getComputedStyle(document.body).fontFamily
  const w = ctx2d.measureText('Frozen').width + 16
  const x = image.x + image.width - w - 8
  const y = image.y + 8
  ctx2d.fillStyle = COLORS.frozen
  ctx2d.beginPath()
  ctx2d.roundRect(x, y, w, 22, 8)
  ctx2d.fill()
  ctx2d.fillStyle = '#fff'
  ctx2d.fillText('Frozen', x + 8, y + 15)
}

function markTap(x: number, y: number): void {
  tapMark = { x, y }
  if (tapTimer) clearTimeout(tapTimer)
  tapTimer = setTimeout(() => {
    tapMark = undefined
    draw()
  }, TAP_MARK_MS)
  draw()
}

new ResizeObserver(draw).observe(canvas)

// ---------------------------------------------------------------- input (mouse rules: core/input/gestures)
interface Press {
  px: number
  py: number
  lx: number
  ly: number
  alt: boolean
  time: number
  lp?: ReturnType<typeof setTimeout>
  longFired: boolean
}
let down: Press | undefined

function pointer(e: MouseEvent): { px: number; py: number } {
  const rc = canvas.getBoundingClientRect()
  return { px: e.clientX - rc.left, py: e.clientY - rc.top }
}

function toLogical(px: number, py: number): [number, number] | undefined {
  const g = geometry()
  const lg = logical()
  return g && lg ? g.panelToLogical(px, py, lg) : undefined
}

/**
 * Sends an input that reaches the device. A frozen screen, a session without input or no session stop it with a hint; a
 * locator highlight ends with the next input; the inspector follows the screen shortly after.
 */
function interact(message: ToHost): boolean {
  if (!connected) return false
  if (frozen) {
    setStatus('The screen is frozen: turn Freeze off to interact with the device')
    return false
  }
  if (caps && !caps.supportsInput) {
    setStatus('Input is not available for this device')
    return false
  }
  if (locatorHighlight) {
    locatorHighlight = false
    matchBounds = []
    draw()
  }
  send(message)
  scheduleAutoRefresh()
  return true
}

/** Re-reads the hierarchy shortly after the last input, so the tree follows what happens on the device. */
function scheduleAutoRefresh(): void {
  if (!inspecting || frozen || recording) return
  if (autoRefresh) clearTimeout(autoRefresh)
  autoRefresh = setTimeout(() => void refreshHierarchy(true), AUTO_REFRESH_DELAY_MS)
}

/** Inspect mode keeps its meaning (a click selects), except with Option/Alt, which interacts with the device. */
/** Clicks inspect instead of acting on the device: inspecting (not while recording, unless frozen) or picking an element to assert on. */
const inspectMode = (): boolean => (inspecting && (!recording || frozen)) || picker !== undefined
const interactive = (alt: boolean): boolean => !inspectMode() || alt

const isContextClick = (e: MouseEvent): boolean => e.button === 2 || (e.button === 0 && e.ctrlKey && /Mac/i.test(navigator.platform))
const longPressMs = (): number => caps?.longPressMs ?? Gestures.LONG_PRESS_MS

function fireLongPress(d: Press): void {
  if (frozen) return
  d.longFired = true
  markTap(d.lx, d.ly)
  cue = { x: d.px, y: d.py }
  if (cueTimer) clearTimeout(cueTimer)
  cueTimer = setTimeout(() => {
    cue = undefined
    draw()
  }, CUE_MS)
  draw()
  interact({ type: 'longPress', x: d.lx, y: d.ly, durationMs: longPressMs() })
}

canvas.addEventListener('mousedown', (e) => {
  canvas.focus()
  if (isContextClick(e)) {
    down = undefined
    return
  }
  if (e.button !== 0) return
  const { px, py } = pointer(e)
  const l = toLogical(px, py)
  if (!l) return
  const d: Press = { px, py, lx: l[0], ly: l[1], alt: e.altKey, time: Date.now(), longFired: false }
  down = d
  if (interactive(e.altKey) && !frozen) d.lp = setTimeout(() => fireLongPress(d), longPressMs())
})

canvas.addEventListener('mousemove', (e) => {
  const { px, py } = pointer(e)
  updateHover(px, py)
  if (down?.lp && Gestures.movedBeyondSlop(px - down.px, py - down.py, SLOP)) {
    // Moving before the timer fires makes it a swipe, not a long press.
    clearTimeout(down.lp)
    down.lp = undefined
  }
  if (inspectMode()) {
    const l = toLogical(px, py)
    const root = inspector.root()
    const next = root && l ? HierarchyQueries.deepestAt(root, l[0], l[1])?.bounds : undefined
    if (next !== hoverBounds) {
      hoverBounds = next
      draw()
    }
  }
})

canvas.addEventListener('mouseleave', () => {
  clearHover()
  if (inspectMode() && hoverBounds) {
    hoverBounds = undefined
    draw()
  }
})

window.addEventListener('mouseup', (e) => {
  const d = down
  down = undefined
  if (!d || e.button !== 0) return
  if (d.lp) clearTimeout(d.lp)
  const { px, py } = pointer(e)
  const end = toLogical(px, py)
  if (!end) return
  const from = [d.lx, d.ly] as const
  // Option/Alt keeps the screen interactive while inspecting. The state at press time decided whether the long press timer
  // ran, so a release cannot contradict the press.
  if (frozen) {
    // Frozen: a click in inspect mode selects from the frozen hierarchy, anything else is only a hint.
    if (inspectMode() && !d.alt) inspectClick(end[0], end[1])
    else setStatus('The screen is frozen: turn Freeze off to interact with the device')
    return
  }
  if (inspectMode() && !d.alt) {
    if (!d.longFired) inspectClick(end[0], end[1])
    return
  }
  const moved = Gestures.movedBeyondSlop(px - d.px, py - d.py, SLOP)
  const duration = Math.min(2000, Math.max(80, Date.now() - d.time))
  const release = Gestures.onRelease(d.longFired, moved, d.alt, e.detail)
  switch (release) {
    case 'CONSUMED':
      break
    case 'TAP':
      markTap(from[0], from[1])
      interact({ type: 'tap', x: from[0], y: from[1] })
      break
    case 'DOUBLE_TAP':
      // Without a fast transport two taps are not a double tap: fall back to a tap, like DeviceViewerPanel.
      markTap(from[0], from[1])
      interact(caps?.supportsDoubleTap ? { type: 'doubleTap', x: from[0], y: from[1] } : { type: 'tap', x: from[0], y: from[1] })
      break
    case 'SWIPE':
      interact({ type: 'swipe', fromX: from[0], fromY: from[1], toX: end[0], toY: end[1], durationMs: duration })
      break
    case 'HOLD_DRAG':
      // Where a hold-drag cannot be sent the click stays the swipe it would have been.
      if (caps?.supportsHoldDrag) interact({ type: 'dragWithHold', fromX: from[0], fromY: from[1], toX: end[0], toY: end[1], holdMs: Gestures.HOLD_DRAG_MS, durationMs: duration })
      else interact({ type: 'swipe', fromX: from[0], fromY: from[1], toX: end[0], toY: end[1], durationMs: duration })
      break
  }
})

// A wheel turn scrolls: scroll down = swipe up, a fifth of the screen per notch.
let wheelAcc = 0
let wheelAt = 0
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (frozen) return setStatus('The screen is frozen: turn Freeze off to interact with the device')
    if (inspectMode() && !e.altKey) return
    const lg = logical()
    const { px, py } = pointer(e)
    const point = toLogical(px, py)
    if (!lg || !point) return
    // Browsers report pixels (about 100 per notch) or lines (about 3 per notch).
    wheelAcc += e.deltaMode === 0 ? e.deltaY / 100 : e.deltaY / 3
    if (Math.abs(wheelAcc) < 0.5 || Date.now() - wheelAt < 120) return
    const distance = Math.trunc(lg.height / 5) * (wheelAcc > 0 ? -1 : 1)
    wheelAcc = 0
    wheelAt = Date.now()
    const toY = Math.min(Math.max(point[1] + distance, 1), lg.height - 1)
    interact({ type: 'swipe', fromX: point[0], fromY: point[1], toX: point[0], toY: toY, durationMs: 200 })
  },
  { passive: false },
)

canvas.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) return
  const special: Record<string, HardwareKey | undefined> = { Enter: 'ENTER', Backspace: 'DELETE', Escape: device?.platform === 'ANDROID' ? 'BACK' : undefined }
  if (e.key in special) {
    e.preventDefault()
    const k = special[e.key]
    if (k && !frozen) interact({ type: 'key', key: k })
  } else if (e.key.length === 1) {
    e.preventDefault()
    interact({ type: 'text', text: e.key })
  }
})

canvas.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')
  if (text) interact({ type: 'text', text })
})

// ---------------------------------------------------------------- hover, grid crosshair and the copy menu
function hoverAt(px: number, py: number): HoverPoint | undefined {
  const g = geometry()
  const lg = logical()
  const frame = frameForGeometry()
  return g && lg && frame ? CoordinateMapper.map(g, px, py, lg, frame) : undefined
}

function updateHover(px: number, py: number): void {
  const point = hoverAt(px, py)
  const changed = point?.x !== hoverPoint?.x || point?.y !== hoverPoint?.y || !point !== !hoverPoint || (gridVisible && (hoverPanel?.x !== px || hoverPanel?.y !== py))
  hoverPoint = point
  hoverPanel = point ? { x: px, y: py } : undefined
  if (point?.x !== hoverReported?.x || point?.y !== hoverReported?.y || !point !== !hoverReported) {
    hoverReported = point
    showHover(point)
  }
  if (changed) draw()
}

function clearHover(): void {
  if (!hoverPoint && !hoverReported) return
  hoverPoint = undefined
  hoverPanel = undefined
  hoverReported = undefined
  showHover(undefined)
  draw()
}

/**
 * Copy menu on right click. It only reads the last known state, so it is offered in every mode (inspect, frozen) and never
 * reaches the device; the click is not a tap and does not select in inspect mode.
 */
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const { px, py } = pointer(e)
  const point = hoverAt(px, py)
  if (!point) return
  const copy = (label: string, text: string): MenuItem => ({ label: `Copy ${label}`, run: () => send({ type: 'copyText', text }) })
  const root = knownRoot()
  const element = ElementInfo.of(root ? HierarchyQueries.deepestAt(root, point.x, point.y) : undefined)
  const items: MenuItem[] = [copy(`"${CoordinateText.xy(point)}"`, CoordinateText.xy(point)), copy(`"${CoordinateText.percent(point)}"`, CoordinateText.percent(point))]
  if (element) items.push('sep', copy(`element size "${CoordinateText.size(element)}"`, CoordinateText.size(element)), copy(`element bounds "${CoordinateText.bounds(element)}"`, CoordinateText.bounds(element)))
  popup(undefined, items, { x: e.clientX, y: e.clientY })
})

// ---------------------------------------------------------------- inspector control, hierarchy capture and freeze
function inspectClick(x: number, y: number): void {
  if (picker) return picker(x, y)
  const root = inspector.root()
  const node = root ? HierarchyQueries.deepestAt(root, x, y) : undefined
  if (node) inspector.select(node)
}

function setInspect(on: boolean): void {
  inspecting = on
  remember({ inspectorOpen: on })
  sideEl.classList.toggle('on', on)
  splitV.style.display = on ? 'block' : 'none'
  applyProportions()
  if (on) {
    if (connected && !frozen) void refreshHierarchy()
  } else {
    if (autoRefresh) clearTimeout(autoRefresh)
    selectedBounds = undefined
    hoverBounds = undefined
  }
  refreshButtons()
  draw()
}

function requestHierarchy(): Promise<Extract<ToWebview, { type: 'hierarchy' }>> {
  const requestId = nextRequest++
  return new Promise((resolve) => {
    pendingHierarchy.set(requestId, resolve)
    send({ type: 'hierarchy', requestId })
  })
}

/** [quiet]: keep the current tree visible while loading (used by the automatic refresh). */
async function refreshHierarchy(quiet = false): Promise<void> {
  if (!connected) return inspector.setMessage('Connect to a device first')
  // The inspector shows the hierarchy captured when the screen was frozen; it must not be replaced.
  if (frozen) return
  if (refreshInFlight) {
    refreshAgain = true
    return
  }
  refreshInFlight = true
  if (!quiet) inspector.setMessage('Loading hierarchy...')
  const reply = await requestHierarchy()
  refreshInFlight = false
  if (connected && !frozen) {
    if (reply.error || !reply.root) inspector.setError(`Hierarchy failed: ${reply.error ?? 'No hierarchy'}`)
    else {
      inspector.setHierarchy(nodeFromDto(reply.root), reply.frameBase64)
      if (!quiet) setStatus(`${[...inspector.root()!.walk()].length} elements`)
    }
  }
  if (refreshAgain) {
    refreshAgain = false
    if (connected && inspecting) void refreshHierarchy(true)
  }
}

/**
 * Freezing keeps the last frame, drops new ones and blocks input. The host captures the hierarchy of that moment right away,
 * because a transient element (toast, snackbar) may be gone from the device soon.
 */
function setFrozen(on: boolean): void {
  if (on === frozen) return
  if (!on) return send({ type: 'freeze', on: false, requestId: 0 })
  if (!connected || !bitmap) return
  const requestId = nextRequest++
  if (!inspecting) setInspect(true)
  if (autoRefresh) clearTimeout(autoRefresh)
  inspector.setMessage('Loading the hierarchy of the frozen screen...')
  pendingHierarchy.set(requestId, (reply) => {
    if (!frozen) return
    if (reply.error || !reply.root) inspector.setError(`Hierarchy failed: ${reply.error ?? 'No hierarchy'}`)
    else inspector.setHierarchy(nodeFromDto(reply.root), reply.frameBase64)
  })
  send({ type: 'freeze', on: true, requestId })
}

function onFrozen(value: boolean): void {
  frozen = value
  selectedBounds = undefined
  hoverBounds = undefined
  if (!value && connected && inspecting) void refreshHierarchy()
  refreshButtons()
  draw()
}

/** The session ended: nothing from it may stay on screen. */
function clearSession(): void {
  connected = false
  bitmap?.close()
  bitmap = undefined
  frameSize = undefined
  frozen = false
  recording = false
  picker = undefined
  refreshInFlight = false
  refreshAgain = false
  if (autoRefresh) clearTimeout(autoRefresh)
  inspector.clear('No hierarchy')
  selectedBounds = undefined
  hoverBounds = undefined
  matchBounds = []
  toolHighlight = []
  locatorHighlight = false
  hoverPoint = undefined
  hoverPanel = undefined
  hoverReported = undefined
  hoverEl.textContent = ' '
  orientation = undefined
  toolViews.forEach((v) => v.deviceChanged?.(undefined))
  refreshButtons()
  draw()
}

// ---------------------------------------------------------------- splitters and layout memory
function remember(patch: LayoutPatch): void {
  if (tracking) send({ type: 'layout', patch })
}

function applyProportions(): void {
  screenEl.style.flex = inspecting ? `${mirrorProportion} 1 0` : '1 1 0'
  sideEl.style.flex = `${1 - mirrorProportion} 1 0`
  mainEl.style.flex = toolsOpen ? `${toolsProportion} 1 0` : '1 1 0'
  toolsEl.style.flex = `${1 - toolsProportion} 1 0`
}

function dragSplitter(handle: HTMLElement, move: (e: MouseEvent) => void, done: () => void): void {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const onUp = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', onUp)
      done()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', onUp)
  })
}
const clampProportion = (v: number): number => Math.min(0.9, Math.max(0.1, v))
dragSplitter(
  splitV,
  (e) => {
    const r = mainEl.getBoundingClientRect()
    mirrorProportion = clampProportion((e.clientX - r.left) / r.width)
    applyProportions()
  },
  () => remember({ mirrorProportion }),
)
dragSplitter(
  splitH,
  (e) => {
    const r = $('work').getBoundingClientRect()
    toolsProportion = clampProportion((e.clientY - r.top) / r.height)
    applyProportions()
  },
  () => remember({ toolsProportion }),
)

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
    viewer: {
      inspector,
      setCopyOptions: (languageName, wholeLine) => {
        copyLanguage = LocatorLanguage.fromName(languageName)
        copyWholeLine = wholeLine
      },
      setRecording: (on) => {
        recording = on
        if (!on) picker = undefined
        refreshButtons()
        draw()
      },
      setPicker: (onPick) => {
        picker = onPick
        hoverBounds = undefined
        refreshButtons()
        draw()
      },
    },
    hierarchy: () => {
      const root = inspector.root()
      return root ? nodeToDto(root) : undefined
    },
    highlight: (b) => {
      toolHighlight = b
      draw()
    },
    status: setStatus,
  }
}

/** Selects [view] as the tab; while the panel is open it also becomes visible (shown/hidden of the previous one are called). */
function showTool(view: ToolView): void {
  if (activeTool === view && mounted.get(view.id)?.classList.contains('on')) return
  const previous = activeTool
  if (previous && previous !== view && toolsOpen) {
    previous.hidden?.()
    send({ type: 'toolHidden', tool: previous.id })
    mounted.get(previous.id)?.classList.remove('on')
  }
  activeTool = view
  for (const b of Array.from(tabsEl.children)) b.classList.toggle('on', (b as HTMLElement).dataset.id === view.id)
  if (!toolsOpen) return
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
    if (connected && device) view.deviceChanged?.(device)
  }
  el.classList.add('on')
  view.shown?.()
  send({ type: 'toolShown', tool: view.id })
}

/** The Device Tools panel: shown or hidden as a whole (the Kotlin `setLogsVisible`). */
function setToolsOpen(open: boolean): void {
  if (open === toolsOpen) return
  toolsOpen = open
  remember({ toolsOpen: open })
  toolsEl.classList.toggle('on', open)
  splitH.style.display = open ? 'block' : 'none'
  applyProportions()
  if (open) {
    const view = activeTool ?? bottomViews[0]
    if (view) {
      mounted.get(view.id)?.classList.remove('on')
      activeTool = undefined
      showTool(view)
    }
  } else if (activeTool) {
    activeTool.hidden?.()
    send({ type: 'toolHidden', tool: activeTool.id })
  }
  refreshButtons()
  draw()
}

// Locators and Recorder are tabs of the inspector (as in the IntelliJ InspectorPanel), the rest is in Device Tools.
const INSPECTOR_TOOLS = new Set(['locators', 'recorder'])
const bottomViews = toolViews.filter((v) => !INSPECTOR_TOOLS.has(v.id))
for (const view of toolViews.filter((v) => INSPECTOR_TOOLS.has(v.id))) {
  const el = document.createElement('div')
  try {
    view.mount(el, apiFor(view))
  } catch (e) {
    el.textContent = `${view.title} failed to start: ${e instanceof Error ? e.message : String(e)}`
  }
  inspector.addTab(view.title, el, (visible) => {
    if (visible) {
      view.shown?.()
      send({ type: 'toolShown', tool: view.id })
    } else {
      view.hidden?.()
      send({ type: 'toolHidden', tool: view.id })
    }
  })
}

for (const view of bottomViews) {
  const b = button(view.title, view.title, () => {
    showTool(view)
    remember({ toolsTab: view.title })
  })
  b.dataset.id = view.id
  tabsEl.append(b)
}
if (bottomViews.length === 0) toolsBtn.style.display = 'none'

// ---------------------------------------------------------------- host messages
window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data
  switch (m.type) {
    case 'restore': {
      const l = m.layout
      mirrorProportion = l.mirrorProportion
      toolsProportion = l.toolsProportion
      gridVisible = m.showGrid
      saveHierarchy = m.saveHierarchyWithScreenshot
      inspector.setFilterText(m.elementFilter ?? '')
      copyLanguage = LocatorLanguage.fromName(m.locatorLanguage)
      copyWholeLine = m.locatorWholeLine ?? false
      applyProportions()
      if (l.inspectorOpen) setInspect(true)
      const saved = new ProjectLayout(l).tabIn(bottomViews.map((t) => t.title))
      const tab = bottomViews.find((v) => v.title === saved)
      if (tab) showTool(tab)
      if (l.toolsOpen) setToolsOpen(true)
      tracking = true
      refreshButtons()
      draw()
      break
    }
    case 'device':
      device = m.device
      titleEl.textContent = m.device.displayName
      if (connected) toolViews.forEach((v) => v.deviceChanged?.(device))
      refreshButtons()
      break
    case 'powerActions':
      powerAvailable = m.available
      refreshButtons()
      break
    case 'power':
      powerBusy = m.busy
      refreshButtons()
      break
    case 'session':
      if (m.connected) {
        connected = true
        toolViews.forEach((v) => v.deviceChanged?.(device))
        if (inspecting) void refreshHierarchy()
        refreshButtons()
      } else clearSession()
      break
    case 'placeholder':
      placeholder = m.text
      draw()
      break
    case 'reconnect':
      cancelEl.style.display = m.waiting ? 'inline' : 'none'
      refreshButtons()
      break
    case 'orientation': {
      const finished = orientationBusy && !m.busy
      orientation = m.value
      orientationBusy = m.busy
      refreshButtons()
      draw()
      // The size changed with the rotation: the tree and the mirror geometry follow.
      if (finished && inspecting && connected) void refreshHierarchy()
      break
    }
    case 'frozen':
      onFrozen(m.frozen)
      break
    case 'foreground':
      foreground = { copyText: m.copyText }
      foregroundEl.style.display = m.visible ? 'block' : 'none'
      foregroundEl.textContent = m.label
      foregroundEl.title = m.tooltip
      break
    case 'capabilities':
      caps = m.capabilities
      refreshButtons()
      draw()
      break
    case 'status':
      setStatus(m.message, m.level, m.holdMs)
      break
    case 'frame': {
      if (frozen) break
      frameCount++
      const seq = ++frameSeq
      frameSize = size(m.width, m.height)
      const bytes = Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0))
      void createImageBitmap(new Blob([bytes], { type: m.mime })).then((bmp) => {
        // Decoding is asynchronous: an older frame must not replace a newer one, and a frozen mirror keeps its frame.
        if (seq < frameApplied || frozen || !connected) return bmp.close()
        frameApplied = seq
        const first = !bitmap
        bitmap?.close()
        bitmap = bmp
        if (first) refreshButtons()
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
    case 'clipboardImage':
      void copyImage(m.base64)
      break
    case 'screenRecording':
      screenRecording = m.active
      refreshButtons()
      break
    case 'locatorMatches': {
      // "Show Locator on Device": the tree it was tried on, the matches highlighted green, the first one selected.
      const root = nodeFromDto(m.root)
      const nodes = [...root.walk()]
      const hits = m.matches.map((i) => nodes[i]).filter((n): n is UiNode => n !== undefined)
      if (inspecting && !frozen) inspector.setHierarchy(root)
      matchBounds = hits.flatMap((n) => (n.bounds ? [n.bounds] : []))
      locatorHighlight = matchBounds.length > 0
      // the old selection came from the previous tree: no match means no selection
      if (inspecting && hits[0]) inspector.select(hits[0])
      else selectedBounds = hits[0]?.bounds
      draw()
      break
    }
  }
})

async function copyImage(base64: string): Promise<void> {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    setStatus('Screenshot copied to the clipboard')
  } catch (e) {
    setStatus(`Could not copy the screenshot: ${e instanceof Error ? e.message : String(e)}. Use Save as PNG instead.`, 'error')
  }
}

refreshButtons()
draw()
send({ type: 'ready' })
