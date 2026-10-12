// ported-from: core/android/EmulatorLink.kt
import type { DeviceKey } from '../model'
import type { FrameListener } from '../session/deviceSession'

/**
 * High bandwidth channel to an Android emulator (implemented with the emulator gRPC API in src/android/grpcEmulatorLink.ts).
 * Kept as an interface so core does not depend on gRPC.
 */
export interface EmulatorLink {
  startStreaming(listener: FrameListener): void
  tap(x: number, y: number): Promise<void>
  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>
  longPress(x: number, y: number, durationMs: number): Promise<void>
  /** Down, up, short gap, down, up: the gap stays well under Android's 300 ms double tap timeout. */
  doubleTap(x: number, y: number): Promise<void>
  /** Press, hold without moving, then move to the end point and release. */
  dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs: number, durationMs: number): Promise<void>
  press(key: DeviceKey): Promise<void>
  typeText(text: string): Promise<void>
  close(): void
}
