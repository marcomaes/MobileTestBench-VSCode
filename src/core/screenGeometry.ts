// ported-from: core/ScreenGeometry.kt
import { rect, rectContainsPoint, sizeIsEmpty, type Rect, type Size } from './model'

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
// Kotlin's roundToInt rounds half up.
const roundToInt = (v: number): number => Math.floor(v + 0.5)

/**
 * Maps between panel coordinates (where the frame is drawn, letterboxed) and the device's logical coordinate space
 * (pixels on Android, points on iOS). Frames may have a different resolution than the logical space (e.g. iOS retina
 * frames), so everything goes through normalized 0..1 coordinates.
 */
export class ScreenGeometry {
  readonly scale: number
  /** Where the frame is drawn inside the panel. */
  readonly imageRect: Rect

  constructor(
    private readonly panel: Size,
    private readonly frame: Size,
    private readonly padding = 8,
  ) {
    this.scale = sizeIsEmpty(frame) ? 0 : Math.max(Math.min((panel.width - 2 * padding) / frame.width, (panel.height - 2 * padding) / frame.height), 0)
    const w = roundToInt(frame.width * this.scale)
    const h = roundToInt(frame.height * this.scale)
    this.imageRect = rect(Math.trunc((panel.width - w) / 2), Math.trunc((panel.height - h) / 2), w, h)
  }

  /** Panel point to logical coordinates, undefined when outside the image. */
  panelToLogical(px: number, py: number, logical: Size): [number, number] | undefined {
    const r = this.imageRect
    if (r.width <= 0 || r.height <= 0 || !rectContainsPoint(r, px, py)) return undefined
    const nx = (px - r.x) / r.width
    const ny = (py - r.y) / r.height
    return [clamp(Math.floor(nx * logical.width), 0, logical.width - 1), clamp(Math.floor(ny * logical.height), 0, logical.height - 1)]
  }

  /** Panel point to pixel coordinates of the frame itself (not the logical space), undefined when outside the image. */
  panelToFrame(px: number, py: number): [number, number] | undefined {
    const r = this.imageRect
    if (r.width <= 0 || r.height <= 0 || !rectContainsPoint(r, px, py)) return undefined
    const nx = (px - r.x) / r.width
    const ny = (py - r.y) / r.height
    return [clamp(Math.floor(nx * this.frame.width), 0, this.frame.width - 1), clamp(Math.floor(ny * this.frame.height), 0, this.frame.height - 1)]
  }

  /** The panel point at the centre of the logical point (x, y), where its marker is drawn. */
  logicalToPanelPoint(x: number, y: number, logical: Size): [number, number] {
    const r = this.imageRect
    if (sizeIsEmpty(logical)) return [r.x, r.y]
    return [Math.trunc(r.x + ((x + 0.5) * r.width) / logical.width), Math.trunc(r.y + ((y + 0.5) * r.height) / logical.height)]
  }

  /** Logical rectangle (e.g. element bounds) to panel rectangle for highlighting. */
  logicalToPanel(rc: Rect, logical: Size): Rect {
    if (sizeIsEmpty(logical)) return rect(0, 0, 0, 0)
    const sx = this.imageRect.width / logical.width
    const sy = this.imageRect.height / logical.height
    return rect(this.imageRect.x + roundToInt(rc.x * sx), this.imageRect.y + roundToInt(rc.y * sy), roundToInt(rc.width * sx), roundToInt(rc.height * sy))
  }
}
