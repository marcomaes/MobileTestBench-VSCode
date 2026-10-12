// ported-from: core/session/DeviceSession.kt
import type { Device, DeviceKey, Size } from '../model'
import type { Frame } from '../image/dimensions'
import type { UiNode } from '../inspector/uiNode'
import type { TransportInfo } from './transportInfo'

export interface FrameListener {
  onFrame(frame: Frame): void
  onStatus?(message: string): void
  onError(message: string, cause?: unknown): void
}

export class UnsupportedOperationOnDevice extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedOperationOnDevice'
  }
}

/**
 * A live connection to one device. Coordinates for input and hierarchy bounds use the same "logical" coordinate space:
 * pixels on Android, points on iOS. Kotlin's blocking methods are async here; only `start`, `close` and the
 * getters are synchronous.
 */
export interface DeviceSession {
  readonly device: Device

  /** Short human readable description of the transport, e.g. "emulator gRPC". */
  readonly transport: string

  /** The transport and, after a fallback, its reason. Never blocks. */
  transportInfo(): TransportInfo | undefined

  readonly supportsInput: boolean

  start(listener: FrameListener): void

  /** Size of the coordinate space used by input and hierarchy bounds, undefined until known. Never blocks. */
  logicalSize(): Size | undefined

  /** Re-reads the logical size after a rotation. Sessions whose size follows the frames need nothing. */
  refreshSize(): Promise<void>

  /** Screen density in dpi, to convert Android pixel bounds to dp; undefined when unknown or when bounds are already points (iOS). */
  density(): Promise<number | undefined>

  tap(x: number, y: number): Promise<void>

  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number): Promise<void>

  /** Holds a finger on (x, y) for [durationMs]. Resolves after the hold. */
  longPress(x: number, y: number, durationMs?: number): Promise<void>

  /** True when [doubleTap] works here: it needs two touches within the platform's double tap timeout (about 300 ms). */
  readonly supportsDoubleTap: boolean

  /** Two quick taps at (x, y), fast enough to count as one double tap. */
  doubleTap(x: number, y: number): Promise<void>

  /** True when [dragWithHold] works here. */
  readonly supportsHoldDrag: boolean

  /** Presses at the start, holds [holdMs] without moving, then moves to the end over [durationMs] and releases. */
  dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs?: number, durationMs?: number): Promise<void>

  press(key: DeviceKey): Promise<void>

  typeText(text: string): Promise<void>

  /** Presses key combinations one after the other in one call, in mobilecli's spelling: `ctrl+a`, `cmd+a`, `backspace`. */
  pressKeys(keys: string[]): Promise<void>

  hierarchy(): Promise<UiNode>

  close(): void
}

/**
 * Base class with the Kotlin interface's default method bodies. Concrete sessions override what they support.
 */
export abstract class BaseDeviceSession implements DeviceSession {
  abstract readonly device: Device
  abstract readonly transport: string
  abstract readonly supportsInput: boolean
  abstract start(listener: FrameListener): void
  abstract logicalSize(): Size | undefined
  abstract tap(x: number, y: number): Promise<void>
  abstract swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number): Promise<void>
  abstract press(key: DeviceKey): Promise<void>
  abstract typeText(text: string): Promise<void>
  abstract hierarchy(): Promise<UiNode>
  abstract close(): void

  transportInfo(): TransportInfo | undefined {
    return undefined
  }
  async refreshSize(): Promise<void> {}
  async density(): Promise<number | undefined> {
    return undefined
  }
  async longPress(_x: number, _y: number, _durationMs = 700): Promise<void> {
    throw new UnsupportedOperationOnDevice('Long press is not available on this connection')
  }
  get supportsDoubleTap(): boolean {
    return false
  }
  async doubleTap(_x: number, _y: number): Promise<void> {
    throw new UnsupportedOperationOnDevice('Double tap is not available on this connection')
  }
  get supportsHoldDrag(): boolean {
    return false
  }
  async dragWithHold(_fx: number, _fy: number, _tx: number, _ty: number, _holdMs = 700, _durationMs = 300): Promise<void> {
    throw new UnsupportedOperationOnDevice('Drag with hold is not available on this connection')
  }
  async pressKeys(_keys: string[]): Promise<void> {
    throw new UnsupportedOperationOnDevice('Key combinations are not available on this connection')
  }
}
