// ported-from: ui/DeviceViewerPanel.kt
// The foundation covers: session lifecycle, frames, input, hierarchy capture and the Device Tools dispatch.
// Reconnect, device power, freeze, orientation, project state and the foreground app poll are ported later
// (see docs/PORTING.md).
import * as vscode from 'vscode'
import { Gestures } from '../core/input/gestures'
import { displayName, type Device } from '../core/model'
import type { Frame } from '../core/image/dimensions'
import type { UiNode } from '../core/inspector/uiNode'
import { IosMobilecliSession } from '../core/ios/iosMobilecliSession'
import { transportTooltip } from '../core/session/transportInfo'
import type { DeviceSession } from '../core/session/deviceSession'
import type { DeviceServices } from '../deviceServices'
import type { Capabilities, ToHost, ToWebview } from '../protocol'
import { readSettings, writeSetting } from './settings'
import { toDto } from './serialize'
import { toolHosts } from './tools'
import type { ToolContext, ToolHost } from './tools/toolHost'

const FRAME_INTERVAL_MS = 33

export class DeviceViewer implements vscode.Disposable {
  private static readonly open = new Map<string, DeviceViewer>()

  /** Opens (or reveals) the viewer of [device]. */
  static show(context: vscode.ExtensionContext, services: DeviceServices, device: Device): DeviceViewer {
    const existing = DeviceViewer.open.get(device.id)
    if (existing) {
      existing.panel.reveal()
      return existing
    }
    const viewer = new DeviceViewer(context, services, device)
    DeviceViewer.open.set(device.id, viewer)
    return viewer
  }

  /** The viewer that was focused last, for editor commands such as Show Locator on Device. */
  static active: DeviceViewer | undefined

  private readonly panel: vscode.WebviewPanel
  private session: DeviceSession | undefined
  private lastFrame: Frame | undefined
  private pendingFrame: Frame | undefined
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private lastHierarchy: UiNode | undefined
  private disposed = false
  private ready = false
  private readonly disposables: vscode.Disposable[] = []
  private readonly tools: ToolHost[]
  private readonly ctx: ToolContext

  private constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly services: DeviceServices,
    readonly device: Device,
  ) {
    this.panel = vscode.window.createWebviewPanel('mobileTestBench.viewer', device.name, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, 'dist'), vscode.Uri.joinPath(extensionContext.extensionUri, 'media')],
    })
    this.panel.iconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'media/icons/toolWindowDevice.svg')
    this.panel.webview.html = this.html()
    this.tools = toolHosts.filter((t) => t.appliesTo?.(device) ?? true)
    this.ctx = this.makeContext()
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) DeviceViewer.active = this
      }),
    )
    DeviceViewer.active = this
  }

  private makeContext(): ToolContext {
    return {
      device: this.device,
      services: this.services,
      settings: readSettings,
      extensionContext: this.extensionContext,
      session: () => this.session,
      hierarchy: () => this.captureHierarchy(),
      emit: () => {}, // replaced per tool in dispatch
      currentFrame: () => (this.lastFrame ? { data: this.lastFrame.data, mime: this.lastFrame.mime, width: this.lastFrame.width, height: this.lastFrame.height } : undefined),
      highlight: (bounds) => this.post({ type: 'highlight', bounds }),
      updateSetting: writeSetting,
    }
  }

  private toolContext(tool: string): ToolContext {
    return { ...this.ctx, emit: (event, data) => this.post({ type: 'toolEvent', tool, event, data }) }
  }

  private post(message: ToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(message)
  }

  private status(message: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'status', message, level })
  }

  private async onMessage(m: ToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true
          this.post({ type: 'device', device: { id: this.device.id, name: this.device.name, platform: this.device.platform, kind: this.device.kind, osVersion: this.device.osVersion, displayName: displayName(this.device) } })
          await this.connect()
          break
        case 'tap':
          await this.session?.tap(m.x, m.y)
          break
        case 'doubleTap':
          await this.session?.doubleTap(m.x, m.y)
          break
        case 'longPress':
          await this.session?.longPress(m.x, m.y, m.durationMs)
          break
        case 'swipe':
          await this.session?.swipe(m.fromX, m.fromY, m.toX, m.toY)
          break
        case 'dragWithHold':
          await this.session?.dragWithHold(m.fromX, m.fromY, m.toX, m.toY, m.holdMs)
          break
        case 'key':
          await this.session?.press(m.key)
          break
        case 'text':
          await this.session?.typeText(m.text)
          break
        case 'hierarchy':
          await this.sendHierarchy(m.requestId)
          break
        case 'tool':
          await this.dispatchTool(m)
          break
        case 'toolShown':
          this.tools.find((t) => t.id === m.tool)?.shown?.(this.toolContext(m.tool))
          break
        case 'toolHidden':
          this.tools.find((t) => t.id === m.tool)?.hidden?.(this.toolContext(m.tool))
          break
      }
    } catch (e) {
      this.status(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  private async dispatchTool(m: Extract<ToHost, { type: 'tool' }>): Promise<void> {
    const tool = this.tools.find((t) => t.id === m.tool)
    try {
      if (!tool) throw new Error(`Unknown tool ${m.tool}`)
      const result = await tool.handle(m.method, m.params, this.toolContext(m.tool))
      this.post({ type: 'toolResult', tool: m.tool, requestId: m.requestId, ok: true, result })
    } catch (e) {
      this.post({ type: 'toolResult', tool: m.tool, requestId: m.requestId, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async connect(): Promise<void> {
    this.status(`Connecting to ${this.device.name}...`)
    try {
      const session = await this.services.createSession(this.device)
      if (this.disposed) return session.close()
      this.session = session
      session.start({
        onFrame: (f) => this.onFrame(f),
        onStatus: (m) => this.status(m),
        onError: (m) => this.status(m, 'error'),
      })
      this.sendCapabilities()
      // Transport and logical size settle after the first frames: refresh once more.
      setTimeout(() => this.sendCapabilities(), 1500)
      this.status(`${session.transport}`)
    } catch (e) {
      this.status(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  private sendCapabilities(): void {
    const s = this.session
    if (!s) return
    const info = s.transportInfo()
    const caps: Capabilities = {
      supportsDoubleTap: s.supportsDoubleTap,
      supportsHoldDrag: s.supportsHoldDrag,
      transport: s.transport,
      transportTooltip: info ? transportTooltip(info) : s.transport,
      logicalSize: s.logicalSize(),
      upright: s instanceof IosMobilecliSession && this.lastFrame ? s.needsUpright(this.lastFrame) : false,
      longPressMs: Gestures.longPressMs(readSettings().longPressMs),
    }
    this.post({ type: 'capabilities', capabilities: caps })
  }

  /** Keeps only the newest frame and sends it at most every [FRAME_INTERVAL_MS]. */
  private onFrame(frame: Frame): void {
    this.lastFrame = frame
    this.pendingFrame = frame
    if (this.frameTimer) return
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined
      const f = this.pendingFrame
      this.pendingFrame = undefined
      if (f) this.post({ type: 'frame', mime: f.mime, base64: f.data.toString('base64'), width: f.width, height: f.height })
    }, FRAME_INTERVAL_MS)
  }

  private async captureHierarchy(): Promise<UiNode> {
    const session = this.session
    if (!session) throw new Error('Not connected')
    const root = await session.hierarchy()
    this.lastHierarchy = root
    return root
  }

  private async sendHierarchy(requestId: number): Promise<void> {
    const frame = this.lastFrame
    try {
      const root = await this.captureHierarchy()
      this.sendCapabilities() // the logical size may have changed (rotation)
      this.post({ type: 'hierarchy', requestId, root: toDto(root), frameBase64: frame?.data.toString('base64') })
    } catch (e) {
      this.post({ type: 'hierarchy', requestId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** The latest captured hierarchy, for editor commands. */
  get hierarchy(): UiNode | undefined {
    return this.lastHierarchy
  }

  private html(): string {
    const web = this.panel.webview
    const script = web.asWebviewUri(vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist/webview/mirror.js'))
    const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('')
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${web.cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobile Test Bench</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameTimer) clearTimeout(this.frameTimer)
    for (const t of this.tools) t.dispose?.(this.toolContext(t.id))
    this.session?.close()
    this.session = undefined
    DeviceViewer.open.delete(this.device.id)
    if (DeviceViewer.active === this) DeviceViewer.active = undefined
    this.disposables.forEach((d) => d.dispose())
    this.panel.dispose()
  }
}
