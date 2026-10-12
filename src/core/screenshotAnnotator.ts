// ported-from: core/ScreenshotAnnotator.kt
import type { Rect, Size } from './model'
import { PixelImage, type PixelReader } from './image/pixels'

const DEFAULT_COLOR = 0x3574f0

/** Draws on a copy of a screen frame, e.g. to point at the element a bug report is about. */
export const ScreenshotAnnotator = {
  /**
   * A copy of [frame] with [bounds] outlined and tinted. [bounds] is in the device's logical space ([logical]),
   * the frame may have another resolution (retina), so the rectangle is scaled.
   * Differs from Java2D: no anti-aliasing, the stroke is a whole number of pixels.
   */
  outline(frame: PixelReader, logical: Size, bounds: Rect, color: number = DEFAULT_COLOR): PixelImage {
    const copy = new PixelImage(frame.width, frame.height)
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) copy.setRgb(x, y, frame.getRgb(x, y))
    if (logical.width <= 0 || logical.height <= 0) return copy
    const sx = frame.width / logical.width
    const sy = frame.height / logical.height
    const x = Math.trunc(bounds.x * sx)
    const y = Math.trunc(bounds.y * sy)
    const w = Math.max(Math.trunc(bounds.width * sx), 1)
    const h = Math.max(Math.trunc(bounds.height * sy), 1)
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    const alpha = 50 / 255
    const blend = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= copy.width || py >= copy.height) return
      const p = copy.getRgb(px, py)
      const mix = (c: number, s: number) => Math.round(c * (1 - alpha) + s * alpha)
      copy.setRgb(px, py, (0xff << 24) | (mix((p >> 16) & 0xff, r) << 16) | (mix((p >> 8) & 0xff, g) << 8) | mix(p & 0xff, b))
    }
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) blend(px, py)
    const stroke = Math.max(2, Math.round(frame.width / 250))
    const half = Math.floor(stroke / 2)
    const solid = (0xff << 24) | (r << 16) | (g << 8) | b
    const paint = (px: number, py: number) => {
      if (px >= 0 && py >= 0 && px < copy.width && py < copy.height) copy.setRgb(px, py, solid)
    }
    // drawRect covers x..x+w and y..y+h; the stroke is centred on that line.
    for (let py = y - half; py <= y + h + (stroke - half - 1); py++) {
      for (let px = x - half; px <= x + w + (stroke - half - 1); px++) {
        const inner = px >= x + (stroke - half) && px <= x + w - half && py >= y + (stroke - half) && py <= y + h - half
        if (!inner) paint(px, py)
      }
    }
    return copy
  },
}
