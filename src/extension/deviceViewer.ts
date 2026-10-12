// ported-from: ui/DeviceViewerPanel.kt
// The host half of the viewer: session lifecycle, reconnect, Device Power, freeze, orientation, project state, the live foreground
// app, screenshots and screen recording. The page half is src/webview/mirror.ts (canvas, input, overlays) and
// src/webview/inspector.ts (the element tree).
//
// What differs from the Kotlin panel: one viewer per device (the device combo box is the Devices tree view, so there is no
// device selection in here and Refresh Devices also refreshes that tree); the toolbar, hover line and status line are DOM in the
// page; the recorder wiring (record / replay / assert, which the Kotlin panel keeps in this class) belongs to the Recorder tab,
// which can use startSnapshots / awaitSnapshot / stopSnapshots below.
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { Apps, type ForegroundApp } from '../core/apps/apps'
import { FreezeState } from '../core/freeze/freezeState'
import { HierarchyDump } from '../core/hierarchyDump'
import type { Frame } from '../core/image/dimensions'
import { Gestures } from '../core/input/gestures'
import { LocatorExtraction } from '../core/inspector/locatorExtraction'
import { ShowLocator, ShowLocatorResult } from '../core/inspector/showLocator'
import type { UiNode } from '../core/inspector/uiNode'
import { IosMobilecliSession } from '../core/ios/iosMobilecliSession'
import { displayName, isSameDevice, type Device } from '../core/model'
import { Orientations, type Orientation } from '../core/orientation'
import { Polling, PowerActions, type PowerAction } from '../core/power/devicePower'
import { ForegroundText, LastDevice, type LayoutPatch, type ProjectLayout } from '../core/project/projectLayout'
import { ReconnectWatcher, type ReconnectEvent } from '../core/reconnect/reconnect'
import { HierarchySnapshots, type Captured } from '../core/recording/hierarchySnapshots'
import type { ScreenRecording } from '../core/recording/screenRecording'
import { ScreenRecordingLimit } from '../core/recording/screenRecordingLimit'
import type { DeviceSession } from '../core/session/deviceSession'
import { transportTooltip } from '../core/session/transportInfo'
import type { DeviceServices } from '../deviceServices'
import type { Capabilities, ToHost, ToWebview } from '../protocol'
import { POWER_UP_TIMEOUT_MS, runPowerAndWait } from './devicePower'
import { ProjectViewState } from './projectViewState'
import { fileStamp, screenshotPng } from './screenshots'
import { toDto } from './serialize'
import { readSettings, writeSetting } from './settings'
import { toolHosts } from './tools'
import type { ToolContext, ToolHost } from './tools/toolHost'

const FRAME_INTERVAL_MS = 33
/** Foreground app polling: interval, call timeout and the delay before a changed layout is saved. */
const FOREGROUND_POLL_MS = 3_000
const FOREGROUND_TIMEOUT_MS = 6_000
const LAYOUT_SAVE_DELAY_MS = 1_000
/** How long the result of "Show Locator on Device" stays in the status line. */
const LOCATOR_STATUS_HOLD_MS = 6_000
/** An error longer than this is a how-to (such as the iPhone agent install): it wraps and stays for a minute. */
const LONG_STATUS_CHARS = 120
const LONG_STATUS_HOLD_MS = 60_000
/** How long a recorded tap waits for a hierarchy taken after the previous action, before using an older one, and the longest wait. */
const FRESH_WAIT_MS = 2_000
const MAX_WAIT_MS = 15_000

export class DeviceViewer implements vscode.Disposable {
  private static readonly open = new Map<string, DeviceViewer>()

  /** Opens (or reveals) the viewer of [device]. */
  static show(context: vscode.ExtensionContext, services: DeviceServices, device: Device): DeviceViewer {
    const existing = [...DeviceViewer.open.values()].find((v) => !v.disposed && isSameDevice(v.device, device))
    if (existing) {
      existing.panel.reveal()
      return existing
    }
    const viewer = new DeviceViewer(context, services, device)
    DeviceViewer.open.set(device.id, viewer)
    return viewer
  }

  /**
   * Setting reconnectToLastDevice: opens the device of the previous session of this workspace, when it is running. Call once on
   * activation. Returns the viewer, or undefined (setting off, nothing remembered, device not running).
   */
  static async restoreLast(context: vscode.ExtensionContext, services: DeviceServices): Promise<DeviceViewer | undefined> {
    if (!readSettings().reconnectToLastDevice || DeviceViewer.open.size > 0) return undefined
    const layout = new ProjectViewState(context.workspaceState).layout()
    const devices = (await services.discovery().discover()).devices
    const device = LastDevice.find(devices, layout.lastDeviceId, layout.lastDeviceName)
    if (!device || device.bootable || DeviceViewer.open.size > 0) return undefined
    return DeviceViewer.show(context, services, device)
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
  private readonly disposables: vscode.Disposable[] = []
  private readonly tools: ToolHost[]
  private readonly ctx: ToolContext
  /** Input runs one after the other, so taps and typing arrive in order (the Kotlin bounded executor of 1). */
  private inputQueue: Promise<void> = Promise.resolve()

  private readonly freeze = new FreezeState()
  private frozenRoot: UiNode | undefined
  private orientation: Orientation | undefined
  private orientationBusy = false

  private readonly reconnect: ReconnectWatcher
  /** Bumped whenever the watch is started, stopped or replaced: a scheduled poll or result of an older watch is dropped. */
  private reconnectGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  /** Bumped for every power operation and on dispose: a result that arrives for an older operation is dropped. */
  private powerGeneration = 0
  private powerBusy = false

  private readonly viewState: ProjectViewState
  private layout: ProjectLayout
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  private foregroundGeneration = 0
  private foregroundInFlight = false
  private foregroundApp: ForegroundApp | undefined
  private foregroundTimer: ReturnType<typeof setInterval> | undefined

  private screenRecording: ScreenRecording | undefined
  private screenRecordingStarting = false
  /** Bumped on every start and stop so an auto stop timer of an earlier recording does nothing. */
  private screenRecordingGeneration = 0

  private snapshots: HierarchySnapshots | undefined
  private locatorGeneration = 0

  private constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly services: DeviceServices,
    public device: Device,
  ) {
    this.viewState = new ProjectViewState(extensionContext.workspaceState)
    this.layout = this.viewState.layout()
    this.reconnect = new ReconnectWatcher(async () => ReconnectWatcher.conclusive(await this.services.discovery().discover(), this.reconnect.target))
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
        // A hidden panel stops the foreground polling; showing it again polls at once.
        if (e.webviewPanel.visible) void this.pollForeground()
        else this.foregroundGeneration++
      }),
    )
    // The init block of the Kotlin panel: the polling starts after every field it uses exists.
    this.foregroundTimer = setInterval(() => void this.pollForeground(), FOREGROUND_POLL_MS)
    DeviceViewer.active = this
  }

  // region tool context

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
    return { ...this.ctx, device: this.device, emit: (event, data) => this.post({ type: 'toolEvent', tool, event, data }) }
  }

  private post(message: ToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(message)
  }

  private status(message: string, level: 'info' | 'error' = 'info', holdMs?: number): void {
    this.post({ type: 'status', message, level, holdMs })
  }

  private placeholder(text: string): void {
    this.post({ type: 'placeholder', text })
  }

  private notify(message: string, kind: 'info' | 'warning' | 'error' = 'info', ...actions: string[]): Thenable<string | undefined> {
    const show = kind === 'error' ? vscode.window.showErrorMessage : kind === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
    return show(message, ...actions)
  }

  // endregion

  // region messages

  private async onMessage(m: ToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': {
          const settings = readSettings()
          this.post({ type: 'restore', layout: this.layout.toJSON(), showGrid: settings.showGrid, saveHierarchyWithScreenshot: settings.saveHierarchyWithScreenshot })
          this.sendDevice()
          if (this.device.bootable) this.placeholder(`${this.device.name} is offline. Use Device Power > Boot.`)
          else await this.connect()
          break
        }
        case 'tap':
          this.input(async (s) => s.tap(m.x, m.y))
          break
        case 'doubleTap':
          // Where a double tap cannot be sent in time the click stays the plain tap it was before.
          this.input(async (s) => (s.supportsDoubleTap ? s.doubleTap(m.x, m.y) : s.tap(m.x, m.y)))
          break
        case 'longPress':
          this.input(async (s) => s.longPress(m.x, m.y, m.durationMs))
          break
        case 'swipe':
          this.input(async (s) => s.swipe(m.fromX, m.fromY, m.toX, m.toY, m.durationMs))
          break
        case 'dragWithHold':
          this.input(async (s) => (s.supportsHoldDrag ? s.dragWithHold(m.fromX, m.fromY, m.toX, m.toY, m.holdMs, m.durationMs) : s.swipe(m.fromX, m.fromY, m.toX, m.toY, m.durationMs)))
          break
        case 'key':
          this.input(async (s) => s.press(m.key))
          break
        case 'text':
          this.input(async (s) => s.typeText(m.text), false)
          break
        case 'promptText': {
          const text = await vscode.window.showInputBox({ title: 'Type Text', prompt: 'Text to type on the device' })
          if (text) this.input(async (s) => s.typeText(text), false)
          break
        }
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
        case 'connect':
          if (this.device.bootable) this.placeholder(`${this.device.name} is offline. Use Device Power > Boot.`)
          else await this.connect()
          break
        case 'disconnect':
          this.disconnect()
          break
        case 'cancelReconnect':
          this.cancelReconnect()
          break
        case 'refreshDevices':
          await this.refreshDevices()
          break
        case 'power':
          await this.runPower(m.action)
          break
        case 'rotate':
          await this.rotate()
          break
        case 'freeze':
          await this.setFrozen(m.on, m.requestId)
          break
        case 'layout':
          this.remember(m.patch)
          break
        case 'showGrid':
          await writeSetting('showGrid', m.on)
          break
        case 'saveHierarchyWithScreenshot':
          await writeSetting('saveHierarchyWithScreenshot', m.on)
          break
        case 'copyText':
          await vscode.env.clipboard.writeText(m.text)
          break
        case 'screenshot':
          await this.screenshot(m.action, m.outline)
          break
        case 'screenRecord':
          if (m.on) await this.startScreenRecording()
          else await this.stopScreenRecording()
          break
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:marcomaes.mobile-test-bench')
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

  /**
   * Input goes to the device in order. A frozen screen and a session without input stop it with a hint.
   * [changesScreen]: false for typing, which keeps the layout, so the recorder's hierarchy stays valid.
   */
  private input(block: (session: DeviceSession) => Promise<void>, changesScreen = true): void {
    const current = this.session
    if (!current) return
    if (this.freeze.frozen) return this.status('The screen is frozen: turn Freeze off to interact with the device')
    if (!current.supportsInput) return this.status('Input is not available for this device')
    this.inputQueue = this.inputQueue.then(async () => {
      try {
        await block(current)
      } catch (e) {
        this.status(`Input failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
      } finally {
        if (changesScreen) this.snapshots?.inputDone()
      }
    })
  }

  // endregion

  // region devices and session

  private sendDevice(): void {
    const d = this.device
    this.post({ type: 'device', device: { id: d.id, name: d.name, platform: d.platform, kind: d.kind, osVersion: d.osVersion, displayName: displayName(d) } })
    this.post({ type: 'powerActions', available: (['BOOT', 'SHUTDOWN', 'REBOOT'] as PowerAction[]).filter((a) => PowerActions.isAvailableFor(a, d)) })
    this.panel.title = d.name
  }

  /** Takes [device] as this viewer's entry (a booted emulator comes back with another serial) and tells the page. */
  private setDevice(device: Device): void {
    if (device === this.device) return
    for (const [key, v] of DeviceViewer.open) if (v === this) DeviceViewer.open.delete(key)
    this.device = device
    DeviceViewer.open.set(device.id, this)
    this.sendDevice()
  }

  /** Looks the device up again (state, serial, offline entry) and refreshes the Devices view. [select]: the entry to take. */
  private async refreshDevices(select?: Device): Promise<void> {
    this.status('Looking for devices...')
    const result = await this.services.discovery().discover()
    void vscode.commands.executeCommand('mobileTestBench.refreshDevices')
    const next = select ?? Polling.reselect(result.devices, this.device)
    if (next) this.setDevice(next)
    if (this.reconnect.phase === 'WAITING') {
      if (this.reconnect.target) this.status(ReconnectWatcher.waitingText(this.reconnect.target, this.reconnect.waitedMs()))
      return
    }
    if (!this.session && this.device.bootable) this.placeholder(`${this.device.name} is offline. Use Device Power > Boot.`)
    const offline = result.devices.filter((d) => d.bootable).length
    this.status(
      result.devices.length === 0 && result.warnings.length > 0
        ? result.warnings.join('  |  ')
        : result.devices.length === 0
          ? 'No running emulators, devices or booted simulators found'
          : `${result.devices.length} device(s) found` + (offline > 0 ? ` (${offline} offline)` : ''),
    )
  }

  /** [automatic]: a reconnect by the watcher; when it fails the watcher goes back to waiting instead of giving up. */
  private async connect(automatic = false): Promise<void> {
    this.disconnect()
    const watchGeneration = this.reconnectGeneration
    const device = this.device
    this.placeholder(`Connecting to ${device.name}...`)
    this.status(`Connecting to ${device.name}...`)
    try {
      const session = await this.services.createSession(device)
      if (this.disposed) return session.close()
      this.session = session
      this.lastFrame = undefined
      session.start({
        onFrame: (f) => this.onFrame(session, f),
        onStatus: (m) => this.status(m),
        onError: (m) => {
          if (this.session !== session) return
          this.reconnect.sessionFailed()
          this.status(m, 'error', m.length > LONG_STATUS_CHARS ? LONG_STATUS_HOLD_MS : undefined)
          void this.notify(m, 'warning')
        },
      })
      this.post({ type: 'session', connected: true })
      this.sendCapabilities()
      // Transport and logical size settle after the first frames: refresh once more.
      setTimeout(() => this.sendCapabilities(), 1500)
      this.status(session.transport)
      if (!session.supportsInput) void this.notify(`Input is not available for ${device.name}. For iOS, start WebDriverAgent and check the WDA URL in the settings.`, 'warning')
      if (this.session === session && this.reconnectGeneration === watchGeneration) this.startWatching(device)
      if (this.session === session) {
        this.remember({ lastDeviceId: device.id, lastDeviceName: device.name })
        void this.pollForeground()
      }
      void this.readOrientation(session)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (automatic) {
        // Usable in discovery but not ready yet (booting): keep waiting.
        if (this.reconnectGeneration === watchGeneration && !this.session) this.startWaiting(device)
        return
      }
      this.placeholder(`Could not connect: ${message}`)
      this.status(message, 'error')
      void this.notify(`Could not connect to ${device.name}: ${message}`, 'error')
    }
  }

  /** [keepWatching]: the reconnect watcher itself closes a lost session and keeps waiting; every other disconnect ends the watch. */
  private disconnect(keepWatching = false): void {
    if (!keepWatching) this.cancelReconnect()
    const old = this.session
    if (!old) return
    this.session = undefined
    this.showForeground(undefined, true)
    void this.setFrozen(false, 0, false)
    this.stopSnapshots()
    if (this.screenRecording) void this.stopScreenRecording()
    this.lastHierarchy = undefined
    this.lastFrame = undefined
    this.pendingFrame = undefined
    this.orientation = undefined
    this.post({ type: 'orientation', value: undefined, busy: false })
    try {
      old.close()
    } catch {
      // closing a dead session may fail
    }
    this.post({ type: 'session', connected: false })
    this.placeholder('Disconnected')
    this.status('Not connected')
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
      upright: this.isUpright(),
      longPressMs: Gestures.longPressMs(readSettings().longPressMs),
      supportsInput: s.supportsInput,
    }
    this.post({ type: 'capabilities', capabilities: caps })
  }

  private isUpright(): boolean {
    const s = this.session
    return s instanceof IosMobilecliSession && this.lastFrame ? s.needsUpright(this.lastFrame) : false
  }

  /** Keeps only the newest frame and sends it at most every [FRAME_INTERVAL_MS]. A frozen mirror keeps its frame and drops new ones. */
  private onFrame(owner: DeviceSession, frame: Frame): void {
    if (this.session !== owner || this.freeze.frozen) return
    this.lastFrame = frame
    this.pendingFrame = frame
    if (this.frameTimer) return
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined
      const f = this.pendingFrame
      this.pendingFrame = undefined
      if (f && !this.freeze.frozen) this.post({ type: 'frame', mime: f.mime, base64: f.data.toString('base64'), width: f.width, height: f.height })
    }, FRAME_INTERVAL_MS)
  }

  // endregion

  // region reconnect

  /** Watch a freshly connected device (if the setting is on). */
  private startWatching(device: Device): void {
    if (!readSettings().reconnectAutomatically) return
    this.reconnect.watch(device)
    this.scheduleReconnectTick(++this.reconnectGeneration)
  }

  /** Wait for [device] to come back without a session (lost, a deliberate shutdown or reboot, or a reconnect that failed). */
  private startWaiting(device: Device): void {
    this.reconnect.waitFor(device)
    const text = ReconnectWatcher.waitingText(device, 0)
    this.placeholder(text)
    this.status(text)
    this.post({ type: 'reconnect', waiting: true })
    this.scheduleReconnectTick(++this.reconnectGeneration)
  }

  /** Ends watching and waiting (Disconnect, Cancel, a new connect, dispose). Safe to call at any time. */
  private cancelReconnect(): void {
    const wasWaiting = this.reconnect.phase === 'WAITING'
    this.reconnect.stop()
    this.reconnectGeneration++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.post({ type: 'reconnect', waiting: false })
    if (wasWaiting && !this.session) {
      this.placeholder('Disconnected')
      this.status('Not connected')
    }
  }

  private scheduleReconnectTick(generation: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.reconnectTick(generation), this.reconnect.pollDelayMs())
  }

  private async reconnectTick(generation: number): Promise<void> {
    if (this.disposed || this.reconnectGeneration !== generation || this.reconnect.phase === 'IDLE') return
    // Device Power polls discovery itself and reports its own result: stay out of its way.
    const event: ReconnectEvent = this.powerBusy ? { kind: 'None' } : await this.reconnect.tick()
    if (this.disposed || this.reconnectGeneration !== generation) return
    switch (event.kind) {
      case 'Lost': {
        this.disconnect(true)
        const text = ReconnectWatcher.waitingText(event.device, 0)
        this.placeholder(text)
        this.status(text)
        this.post({ type: 'reconnect', waiting: true })
        break
      }
      case 'StillWaiting':
        if (!this.powerBusy) this.status(ReconnectWatcher.waitingText(event.device, event.waitedMs))
        break
      case 'Reconnected':
        this.post({ type: 'reconnect', waiting: false })
        this.setDevice(event.device)
        void vscode.commands.executeCommand('mobileTestBench.refreshDevices')
        await this.connect(true)
        return
      case 'None':
        break
    }
    if ((this.reconnect.phase as string) !== 'IDLE') this.scheduleReconnectTick(generation)
  }

  // endregion

  // region device power

  private async runPower(action: PowerAction): Promise<void> {
    const device = this.device
    if (this.powerBusy || !PowerActions.isAvailableFor(action, device)) return
    if (PowerActions.needsConfirmation(action)) {
      const answer = await vscode.window.showWarningMessage(PowerActions.confirmText(action, device), { modal: true }, 'Yes')
      if (answer !== 'Yes') return
    }
    const generation = ++this.powerGeneration
    // The session must not outlive the device: disconnect first when it is the one being shut down or rebooted.
    const ownSession = action !== 'BOOT' && this.session !== undefined && isSameDevice(this.session.device, device)
    const wantBack = ownSession && readSettings().reconnectAutomatically
    if (ownSession) this.disconnect()
    this.powerBusy = true
    this.post({ type: 'power', busy: true })
    // The watcher waits for the device to come back, but stays quiet until this operation is over (see reconnectTick).
    if (wantBack) this.startWaiting(device)
    this.status(PowerActions.progressText(action, device))
    const stale = (): boolean => this.powerGeneration !== generation || this.disposed
    const outcome = await runPowerAndWait(this.services, action, device, stale, () => this.status(`Waiting for ${device.name} to come up...`))
    if (stale()) return
    this.powerBusy = false
    this.post({ type: 'power', busy: false })
    await this.refreshDevices(outcome.up ?? device)
    const label = PowerActions.label(action)
    const waiting = this.reconnect.phase === 'WAITING' && this.reconnect.target !== undefined && isSameDevice(this.reconnect.target, device)
    const seconds = POWER_UP_TIMEOUT_MS / 1000
    if (waiting && outcome.error) void this.notify(`${label} of ${device.name} failed: ${outcome.error}. Still waiting for it to come back.`, 'error')
    else if (waiting && outcome.timedOut) void this.notify(`${device.name} did not appear within ${seconds} s. Still waiting for it to come back.`, 'warning')
    else if (waiting && outcome.up) {
      // the watcher reconnects on its next poll
    } else if (waiting) void this.notify(`${device.name} was shut down. The panel reconnects when it is back.`)
    else if (outcome.error) void this.notify(`${label} of ${device.name} failed: ${outcome.error}`, 'error')
    else if (outcome.timedOut) void this.notify(`${device.name} did not appear within ${seconds} s. Press Refresh Devices when it has started.`, 'warning')
    else if (outcome.up) this.offerConnect(outcome.up, action === 'REBOOT' ? 'rebooted' : 'booted')
    else void this.notify(`${device.name} was shut down.`)
  }

  /** A notification with a Connect button; the device is not connected on its own (a reboot's session cannot be restored reliably). */
  private offerConnect(device: Device, verb: string): void {
    void this.notify(`${device.name} ${verb}. Connect to it?`, 'info', 'Connect').then((pick) => {
      if (pick !== 'Connect' || this.disposed) return
      this.setDevice(device)
      void this.connect()
    })
  }

  // endregion

  // region orientation

  /** Reads the device orientation so the toggle shows the real state, also after external rotations. */
  private async readOrientation(current: DeviceSession): Promise<Orientation | undefined> {
    let value: Orientation | undefined
    try {
      value = Orientations.parse(await this.services.mobilecliCall(current.device, Orientations.getArgs()))
    } catch {
      value = undefined
    }
    // A failed read keeps the last known value instead of resetting it to unknown.
    if (value && this.session === current) {
      this.orientation = value
      this.post({ type: 'orientation', value, busy: this.orientationBusy })
    }
    return value
  }

  /** Rotates the device, re-reads the real orientation and size, then refreshes mirror geometry (the page refreshes the inspector). */
  private async rotate(): Promise<void> {
    const current = this.session
    if (!current || this.orientationBusy) return
    const target = Orientations.other(this.orientation ?? 'portrait')
    this.orientationBusy = true
    this.post({ type: 'orientation', value: this.orientation, busy: true })
    this.status(`Rotating to ${target}...`)
    let error: string | undefined
    try {
      await this.services.mobilecliCall(current.device, Orientations.setArgs(target), 30_000)
      // If the confirming read fails, trust the set that just succeeded.
      if ((await this.readOrientation(current)) === undefined && this.session === current) this.orientation = target
      await current.refreshSize()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    this.orientationBusy = false
    if (this.session !== current) return
    if (error) void this.notify(`Could not rotate ${current.device.name}: ${error}`, 'warning')
    this.sendCapabilities()
    this.post({ type: 'orientation', value: this.orientation, busy: false })
  }

  // endregion

  // region hierarchy and freeze

  private async captureHierarchy(): Promise<UiNode> {
    const session = this.session
    if (!session) throw new Error('Not connected')
    if (this.freeze.frozen) {
      if (!this.frozenRoot) throw new Error('The frozen screen has no hierarchy yet')
      return this.frozenRoot
    }
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

  /**
   * Freezing keeps the last frame, drops new ones and blocks input. The hierarchy of that moment is captured right away, because a
   * transient element (toast, snackbar) may be gone from the device soon; it is answered as `hierarchy` for [requestId].
   */
  private async setFrozen(on: boolean, requestId: number, announce = true): Promise<void> {
    if (on === this.freeze.frozen) return
    if (on) {
      const current = this.session
      const frame = this.lastFrame
      if (!current || !frame) return this.post({ type: 'frozen', frozen: false })
      const token = this.freeze.freeze()
      this.pendingFrame = undefined
      // The tree from before the freeze does not match the frozen frame: nothing may be picked from it.
      this.lastHierarchy = undefined
      this.frozenRoot = undefined
      this.post({ type: 'frozen', frozen: true })
      this.status('Frozen: the screen is not updated and input is blocked')
      try {
        const root = await current.hierarchy()
        if (this.session === current && this.freeze.isCurrent(token)) {
          this.frozenRoot = root
          this.lastHierarchy = root
          this.post({ type: 'hierarchy', requestId, root: toDto(root), frameBase64: frame.data.toString('base64') })
        }
      } catch (e) {
        if (this.session === current && this.freeze.isCurrent(token)) this.post({ type: 'hierarchy', requestId, error: e instanceof Error ? e.message : String(e) })
      }
    } else {
      this.freeze.unfreeze()
      this.frozenRoot = undefined
      if (announce) this.post({ type: 'frozen', frozen: false })
    }
  }

  /** The newest hierarchy known without asking the device: the inspector's or frozen one, else the newest recorder snapshot. */
  lastKnownHierarchy(): UiNode | undefined {
    return this.lastHierarchy ?? this.snapshots?.latest()
  }

  /** The latest captured hierarchy, for editor commands. */
  get hierarchy(): UiNode | undefined {
    return this.lastHierarchy
  }

  // endregion

  // region hierarchy snapshots (for the recorder)

  /** Starts keeping a recent hierarchy ready (the Kotlin `setRecording(true)`); the Recorder tab asks for it with [awaitSnapshot]. */
  startSnapshots(): void {
    const current = this.session
    if (!current || this.snapshots) return
    this.snapshots = new HierarchySnapshots(() => current.hierarchy())
    this.snapshots.start()
  }

  stopSnapshots(): void {
    this.snapshots?.close()
    this.snapshots = undefined
  }

  /** A hierarchy for a recorded gesture: a fresh one if it comes quickly, else the newest older one (see HierarchySnapshots). */
  awaitSnapshot(): Promise<Captured> {
    if (!this.snapshots) return Promise.reject(new Error('Recording is not running'))
    return this.snapshots.awaitFresh(FRESH_WAIT_MS, MAX_WAIT_MS)
  }

  // endregion

  // region project state and live foreground app

  /** Records a change and saves it shortly after (debounced). */
  private remember(patch: LayoutPatch): void {
    const next = this.layout.merge(patch)
    if (next.equals(this.layout)) return
    this.layout = next
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveLayoutNow(), LAYOUT_SAVE_DELAY_MS)
  }

  private async saveLayoutNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      await this.viewState.save(this.layout)
    } catch (e) {
      console.warn('Could not save the project state', e)
    }
  }

  private showForeground(app: ForegroundApp | undefined, clear = false): void {
    this.foregroundApp = app
    if (clear) {
      this.foregroundGeneration++
      this.post({ type: 'foreground', visible: false, label: ' ', tooltip: '' })
      return
    }
    this.post({ type: 'foreground', visible: true, label: ForegroundText.label(app), tooltip: ForegroundText.tooltip(app), copyText: ForegroundText.copyText(app) })
  }

  /** The id of the app in front, undefined on the home screen or when unknown (for tools that follow the foreground app). */
  get foregroundAppId(): string | undefined {
    return this.foregroundApp && !this.foregroundApp.isHome ? this.foregroundApp.id : undefined
  }

  /** One `apps foreground` call at a time; the result is dropped when the generation or the device changed meanwhile. */
  private async pollForeground(): Promise<void> {
    const current = this.session
    if (!current || !this.panel.visible || this.foregroundInFlight || this.powerBusy || this.disposed) return
    const generation = this.foregroundGeneration
    this.foregroundInFlight = true
    let app: ForegroundApp | undefined
    try {
      app = Apps.parseForeground(await this.services.mobilecliData(current.device, ['apps', 'foreground'], FOREGROUND_TIMEOUT_MS))
    } catch {
      app = undefined
    }
    this.foregroundInFlight = false
    if (this.foregroundGeneration === generation && this.session === current && !this.disposed) this.showForeground(app)
  }

  // endregion

  // region show locator from the editor

  /**
   * "Show Locator on Device": tries the locator in [text] (a selection or a line of code) on the connected device and highlights the
   * matches. The result stays in the status line for a few seconds and is returned for the caller's notification.
   */
  async showLocator(text: string): Promise<ShowLocatorResult> {
    const current = this.session
    const report = (result: ShowLocatorResult): ShowLocatorResult => {
      this.status(`Locator: ${result.message()}`, 'info', LOCATOR_STATUS_HOLD_MS)
      return result
    }
    if (!current) return report(ShowLocatorResult.NoDevice)
    if (!LocatorExtraction.extract(text)) return report(ShowLocatorResult.NoLocator)
    const generation = ++this.locatorGeneration
    let root: UiNode
    if (this.freeze.frozen) {
      // The screen the user sees is the frozen one: try the locator on the hierarchy of that moment.
      if (!this.frozenRoot) return report(new ShowLocatorResult.Failed('the frozen screen has no hierarchy yet'))
      root = this.frozenRoot
    } else {
      this.status(`Trying the locator on ${current.device.name}...`)
      try {
        root = await current.hierarchy()
      } catch (e) {
        return report(new ShowLocatorResult.Failed((e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]))
      }
      if (this.session !== current || this.locatorGeneration !== generation || this.freeze.frozen) return ShowLocatorResult.NoDevice
      this.lastHierarchy = root
    }
    const result = ShowLocator.evaluate(text, root)
    const all = [...root.walk()]
    const matches = result instanceof ShowLocatorResult.Matches ? result.nodes.map((n) => all.indexOf(n)).filter((i) => i >= 0) : []
    this.post({ type: 'locatorMatches', root: toDto(root), matches, message: `Locator: ${result.message()}` })
    this.status(`Locator: ${result.message()}`, 'info', LOCATOR_STATUS_HOLD_MS)
    return result
  }

  // endregion

  // region screenshot and screen recording

  private defaultFolder(): vscode.Uri {
    return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir())
  }

  /** Copy (through the page, which owns the clipboard of a webview) or save the current frame, optionally with an element outlined. */
  private async screenshot(action: 'copy' | 'save', outline?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const frame = this.lastFrame
    const session = this.session
    if (!frame || !session) return this.status('No screen to capture yet')
    const png = screenshotPng(frame, this.isUpright(), session.logicalSize(), outline)
    if (action === 'copy') {
      this.post({ type: 'clipboardImage', base64: png.toString('base64') })
      return
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Save Screenshot',
      defaultUri: vscode.Uri.joinPath(this.defaultFolder(), fileStamp(session.device.name, 'png')),
      filters: { 'PNG image': ['png'] },
    })
    if (!target) return
    try {
      await vscode.workspace.fs.writeFile(target, png)
      let message = `Screenshot saved to ${target.fsPath}`
      if (readSettings().saveHierarchyWithScreenshot) {
        const root = this.lastKnownHierarchy() ?? (await session.hierarchy().catch(() => undefined))
        if (root) {
          const xml = HierarchyDump.siblingFile(target.fsPath)
          await vscode.workspace.fs.writeFile(vscode.Uri.file(xml), Buffer.from(HierarchyDump.toXml(root), 'utf8'))
          message = `Screenshot and hierarchy saved to ${target.fsPath} and ${path.basename(xml)}`
        } else message += ' (no hierarchy available)'
      }
      this.status(message)
    } catch (e) {
      this.status(`Could not save the screenshot: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  private async startScreenRecording(): Promise<void> {
    const device = this.session?.device
    if (!device || this.screenRecording || this.screenRecordingStarting) return
    const target = await vscode.window.showSaveDialog({
      title: 'Save Screen Recording',
      defaultUri: vscode.Uri.joinPath(this.defaultFolder(), fileStamp(device.name, 'mp4')),
      filters: { 'MP4 video': ['mp4'] },
    })
    if (!target) return this.post({ type: 'screenRecording', active: false })
    this.screenRecordingStarting = true
    this.post({ type: 'screenRecording', active: true })
    this.status('Starting screen recording...')
    try {
      const recording = await this.services.startScreenRecording(device, target.fsPath)
      this.screenRecording = recording
      const generation = ++this.screenRecordingGeneration
      const limitMs = ScreenRecordingLimit.limitMs(readSettings().screenRecordingLimitSeconds)
      this.status(`Recording the screen to ${target.fsPath}: press the button again to stop` + (limitMs ? ` (stops by itself after ${Math.trunc(limitMs / 1000)} s)` : ''))
      if (limitMs) {
        setTimeout(() => {
          if (this.screenRecordingGeneration === generation && this.screenRecording === recording) void this.stopScreenRecording()
        }, limitMs)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.post({ type: 'screenRecording', active: false })
      this.status(`Could not record the screen: ${message.split(/\r?\n/)[0]}`, 'error')
      void this.notify(`Could not record the screen: ${message}`, 'warning')
    } finally {
      this.screenRecordingStarting = false
    }
  }

  private async stopScreenRecording(): Promise<void> {
    const recording = this.screenRecording
    if (!recording) return
    this.screenRecording = undefined
    this.screenRecordingGeneration++
    this.post({ type: 'screenRecording', active: false })
    this.status('Finishing the video...')
    try {
      const file = await recording.stop()
      const { size } = await vscode.workspace.fs.stat(vscode.Uri.file(file))
      this.status(`Screen recording saved to ${file} (${Math.trunc(size / 1024)} KB)`)
    } catch (e) {
      this.status(`Screen recording failed: ${(e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]}`, 'error')
    }
  }

  // endregion

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
    void this.saveLayoutNow()
    this.disposed = true
    if (this.foregroundTimer) clearInterval(this.foregroundTimer)
    this.foregroundGeneration++
    this.locatorGeneration++
    this.reconnect.stop()
    this.reconnectGeneration++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.powerGeneration++
    this.stopSnapshots()
    if (this.frameTimer) clearTimeout(this.frameTimer)
    void this.screenRecording?.stop().catch(() => undefined)
    this.screenRecording = undefined
    for (const t of this.tools) t.dispose?.(this.toolContext(t.id))
    this.session?.close()
    this.session = undefined
    for (const [key, v] of DeviceViewer.open) if (v === this) DeviceViewer.open.delete(key)
    if (DeviceViewer.active === this) DeviceViewer.active = undefined
    this.disposables.forEach((d) => d.dispose())
    this.panel.dispose()
  }
}
