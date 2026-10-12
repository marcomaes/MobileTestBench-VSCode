// No Kotlin counterpart: what the webview gives a Device Tools tab (the webview half of a DeviceToolTab).
import type { Capabilities, DeviceInfoDto, NodeDto } from '../protocol'

export interface ToolApi {
  readonly device: DeviceInfoDto | undefined
  readonly capabilities: Capabilities | undefined
  /** Calls the host half of this tool. Rejects with the host's error message. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Subscribes to events the host half emits. Returns an unsubscribe function. */
  on(event: string, handler: (data: unknown) => void): () => void
  /** The current hierarchy as the inspector last captured it (may be undefined). */
  hierarchy(): NodeDto | undefined
  /** Highlights a rectangle (logical coordinates) on the mirror. */
  highlight(bounds: Array<{ x: number; y: number; width: number; height: number }>): void
  /** Sends text to the status line of the viewer. */
  status(message: string, level?: 'info' | 'error'): void
}

/** The webview half of a Device Tools tab. */
export interface ToolView {
  readonly id: string
  readonly title: string
  /** Builds the tab content. Called once, when the tab is first shown. */
  mount(root: HTMLElement, api: ToolApi): void
  /** The device changed (Kotlin `deviceChanged`). */
  deviceChanged?(device: DeviceInfoDto | undefined): void
  /** The tab became visible or hidden (Kotlin `shown` / `hidden`). */
  shown?(): void
  hidden?(): void
}
