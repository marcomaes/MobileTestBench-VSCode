// No Kotlin counterpart: the message protocol between the extension host and the viewer webview.
// Both sides import these types, so the compiler keeps them in step.
import type { Platform } from './core/model'

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
}

export type HardwareKey = 'HOME' | 'BACK' | 'APP_SWITCH' | 'ENTER' | 'DELETE' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'POWER'

/** Webview to host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'doubleTap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number; durationMs: number }
  | { type: 'swipe'; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'dragWithHold'; fromX: number; fromY: number; toX: number; toY: number; holdMs: number }
  | { type: 'key'; key: HardwareKey }
  | { type: 'text'; text: string }
  | { type: 'hierarchy'; requestId: number }
  | { type: 'tool'; tool: string; requestId: number; method: string; params?: unknown }
  | { type: 'toolShown'; tool: string }
  | { type: 'toolHidden'; tool: string }

/** Host to webview. */
export type ToWebview =
  | { type: 'device'; device: DeviceInfoDto }
  | { type: 'frame'; mime: string; base64: string; width: number; height: number }
  | { type: 'capabilities'; capabilities: Capabilities }
  | { type: 'status'; message: string; level: 'info' | 'error' }
  | { type: 'hierarchy'; requestId: number; root?: NodeDto; error?: string; frameBase64?: string }
  | { type: 'toolResult'; tool: string; requestId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'toolEvent'; tool: string; event: string; data?: unknown }
  | { type: 'highlight'; bounds: Array<{ x: number; y: number; width: number; height: number }> }
