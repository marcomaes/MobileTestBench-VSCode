// No Kotlin counterpart: replaces DeviceToolTab (ui/DeviceToolsPanel.kt) on the host side.
import type * as vscode from 'vscode'
import type { Device } from '../../core/model'
import type { DeviceSession } from '../../core/session/deviceSession'
import type { UiNode } from '../../core/inspector/uiNode'
import type { DeviceServices } from '../../deviceServices'
import type { Settings } from '../../settings'

/** What a tool can use. One context per open device viewer. */
export interface ToolContext {
  readonly device: Device
  readonly services: DeviceServices
  readonly settings: () => Settings
  readonly extensionContext: vscode.ExtensionContext
  /** The live session, undefined while connecting or after a drop. */
  session(): DeviceSession | undefined
  /** The hierarchy of the current screen, fetched from the device (or the frozen one). */
  hierarchy(): Promise<UiNode>
  /** Pushes an event to this tool's webview half. */
  emit(event: string, data?: unknown): void
  /** Latest frame as PNG or JPEG bytes. */
  currentFrame(): { data: Buffer; mime: string; width: number; height: number } | undefined
  /** Highlights rectangles (logical coordinates) on the mirror. */
  highlight(bounds: Array<{ x: number; y: number; width: number; height: number }>): void
  /** Writes a setting back to VS Code's configuration. */
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>
}

/**
 * The host half of a Device Tools tab. The webview half is src/webview/tools/<id>.ts. Calls from the webview arrive
 * in `handle` as `method` + `params`; whatever it returns (or throws) goes back to the webview half.
 */
export interface ToolHost {
  readonly id: string
  readonly title: string
  /** True when the tab makes sense for the device (the Kotlin `deviceChanged` hides or disables tabs). Default: always. */
  appliesTo?(device: Device): boolean
  handle(method: string, params: unknown, ctx: ToolContext): Promise<unknown>
  /** The tab became visible (Kotlin `shown`): start polling or streaming. */
  shown?(ctx: ToolContext): void
  /** The tab was hidden (Kotlin `hidden`): stop it. */
  hidden?(ctx: ToolContext): void
  /** The viewer closed or the device changed (Kotlin `dispose`). */
  dispose?(ctx: ToolContext): void
}
