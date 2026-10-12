// ported-from: core/Orientation.kt
import type { Size } from './model'
import { sizeIsEmpty, sizeIsLandscape } from './model'
import { MobilecliException, MobilecliJson } from './mobilecliJson'

/** Screen orientation as mobilecli reports and accepts it (`device orientation get|set`). */
export type Orientation = 'portrait' | 'landscape'

export const Orientations = {
  fromValue: (value: string | undefined): Orientation | undefined => (value?.trim() === 'portrait' || value?.trim() === 'landscape' ? (value.trim() as Orientation) : undefined),
  other: (o: Orientation): Orientation => (o === 'portrait' ? 'landscape' : 'portrait'),
  /** Arguments of `mobilecli device orientation get` (the device is appended by MobilecliJson.commandLine). */
  getArgs: (): string[] => ['device', 'orientation', 'get'],
  /** Arguments of `mobilecli device orientation set <value>`; mobilecli accepts lower case only. */
  setArgs: (o: Orientation): string[] => ['device', 'orientation', 'set', o],
  /** Reads `{"status":"ok","data":{"orientation":"landscape"}}` (the reply of both get and set). Throws on an error or an unknown value. */
  parse(stdout: string): Orientation {
    const data = MobilecliJson.data(stdout)
    const raw = data && typeof data === 'object' ? (data as { orientation?: unknown }).orientation : undefined
    const value = typeof raw === 'string' ? raw : undefined
    const parsed = Orientations.fromValue(value)
    if (!parsed) throw new MobilecliException(`Unexpected orientation reply: ${value ?? stdout.trim().slice(0, 100)}`)
    return parsed
  },
}

export const FrameOrientation = {
  /**
   * iOS simulators keep delivering the portrait framebuffer after a rotation, with the content drawn rotated 90 degrees
   * clockwise. True when the frame is portrait but the logical size is landscape: the viewer then turns it 90 degrees
   * counter-clockwise (the Kotlin plugin does that with Graphics2D, the webview does it on its canvas).
   */
  needsUpright(frame: Size, logical: Size | undefined): boolean {
    return !(!logical || sizeIsEmpty(logical) || !sizeIsLandscape(logical) || frame.width >= frame.height)
  },
}
