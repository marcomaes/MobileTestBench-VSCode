// No Kotlin counterpart: the message protocol between the extension host and the viewer webview.
// Both sides import these types, so the compiler keeps them in step.
import type { Platform } from './core/model'
import type { PowerAction } from './core/power/devicePower'
import type { LayoutPatch } from './core/project/projectLayout'

export type OrientationName = 'portrait' | 'landscape'
export type RectDto = { x: number; y: number; width: number; height: number }

/** A UI hierarchy node as sent to the webview (rebuilt there into a core UiNode). */
export interface NodeDto {
  platform: Platform
  rawType: string
  attributes: Record<string, string>
  bounds?: { x: number; y: number; width: number; height: number }
  children: NodeDto[]
}

export interface DeviceInfoDto {
  id: string
  name: string
  platform: Platform
  kind: string
  osVersion?: string
  displayName: string
}

export interface Capabilities {
  supportsDoubleTap: boolean
  supportsHoldDrag: boolean
  transport: string
  transportTooltip: string
  logicalSize?: { width: number; height: number }
  /** iOS simulators deliver a portrait framebuffer in landscape: the webview turns the frame upright. */
  upright: boolean
  longPressMs: number
  /** False for a session without input (an iOS simulator without WebDriverAgent). */
  supportsInput: boolean
}

export type HardwareKey = 'HOME' | 'BACK' | 'APP_SWITCH' | 'ENTER' | 'DELETE' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'POWER'

/** Webview to host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'doubleTap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number; durationMs: number }
  | { type: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | { type: 'dragWithHold'; fromX: number; fromY: number; toX: number; toY: number; holdMs: number; durationMs?: number }
  | { type: 'key'; key: HardwareKey }
  | { type: 'text'; text: string }
  | { type: 'hierarchy'; requestId: number }
  | { type: 'tool'; tool: string; requestId: number; method: string; params?: unknown }
  | { type: 'toolShown'; tool: string }
  | { type: 'toolHidden'; tool: string }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'cancelReconnect' }
  | { type: 'refreshDevices' }
  | { type: 'power'; action: PowerAction }
  | { type: 'rotate' }
  /** Freezes (or releases) the mirror; the host captures the hierarchy of that moment and answers with `hierarchy` for [requestId]. */
  | { type: 'freeze'; on: boolean; requestId: number }
  /** Asks the host for a text (an input box) and types it on the device. */
  | { type: 'promptText' }
  | { type: 'layout'; patch: LayoutPatch }
  | { type: 'showGrid'; on: boolean }
  | { type: 'saveHierarchyWithScreenshot'; on: boolean }
  | { type: 'copyText'; text: string }
  /** [action] copy puts a PNG on the clipboard (through `clipboardImage`), save asks for a file. [outline]: logical bounds to outline. */
  | { type: 'screenshot'; action: 'copy' | 'save'; outline?: RectDto }
  | { type: 'screenRecord'; on: boolean }
  | { type: 'openSettings' }
  /** The element filter text of the tree changed (setting elementFilter). */
  | { type: 'elementFilter'; text: string }

/** Host to webview. */
export type ToWebview =
  | { type: 'device'; device: DeviceInfoDto }
  | { type: 'frame'; mime: string; base64: string; width: number; height: number }
  | { type: 'capabilities'; capabilities: Capabilities }
  /** [holdMs]: the fps line does not replace this text for that long (a how-to, a locator result). */
  | { type: 'status'; message: string; level: 'info' | 'error'; holdMs?: number }
  | { type: 'hierarchy'; requestId: number; root?: NodeDto; error?: string; frameBase64?: string }
  | { type: 'toolResult'; tool: string; requestId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'toolEvent'; tool: string; event: string; data?: unknown }
  | { type: 'highlight'; bounds: Array<{ x: number; y: number; width: number; height: number }> }
  /** Sent once after `ready`: the saved layout and the grid setting. */
  | { type: 'restore'; layout: Required<LayoutPatch>; showGrid: boolean; saveHierarchyWithScreenshot: boolean; elementFilter?: string; locatorLanguage?: string; locatorWholeLine?: boolean }
  /** The text drawn on the empty screen (Connecting, Disconnected, offline hint, waiting for a device). */
  | { type: 'placeholder'; text: string }
  /** A session is live (true) or gone (false). When it ends the webview clears its frame, hierarchy and overlays. */
  | { type: 'session'; connected: boolean }
  /** The reconnect watcher is waiting for the device: show the Cancel link. */
  | { type: 'reconnect'; waiting: boolean }
  /** A Device Power operation is running: the status line shows its progress, polling is paused. */
  | { type: 'power'; busy: boolean }
  /** The Device Power actions that make sense for the device in its current state. */
  | { type: 'powerActions'; available: PowerAction[] }
  | { type: 'orientation'; value?: OrientationName; busy: boolean }
  | { type: 'frozen'; frozen: boolean }
  | { type: 'foreground'; visible: boolean; label: string; tooltip: string; copyText?: string }
  | { type: 'clipboardImage'; base64: string }
  | { type: 'screenRecording'; active: boolean }
  /** Result of "Show Locator on Device": the hierarchy it was evaluated on, the matches (indices in depth first order) and the line to show. */
  | { type: 'locatorMatches'; root: NodeDto; matches: number[]; message: string }
