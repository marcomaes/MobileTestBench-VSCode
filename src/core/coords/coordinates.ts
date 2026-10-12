// ported-from: core/coords/Coordinates.kt
import { formatFixed } from '../javaFormat'
import { sizeEquals, sizeIsEmpty, type Platform, type Rect, type Size } from '../model'
import type { ScreenGeometry } from '../screenGeometry'
import type { UiNode } from '../inspector/uiNode'

/**
 * A point on the mirror: the logical device coordinates (points on iOS, pixels on Android), the pixel of the
 * frame image under it and the position in percent of the logical size (the centre of the logical unit).
 */
export interface HoverPoint {
  readonly x: number
  readonly y: number
  readonly frameX: number
  readonly frameY: number
  readonly percentX: number
  readonly percentY: number
  /** True when the frame has a different resolution than the logical space (iOS retina), so the frame pixels are worth showing. */
  readonly frameDiffers: boolean
}

export const CoordinateMapper = {
  /** Panel point to a [HoverPoint]; undefined outside the drawn frame or without a usable size. */
  map(geometry: ScreenGeometry, px: number, py: number, logical: Size, frame: Size): HoverPoint | undefined {
    if (sizeIsEmpty(logical) || sizeIsEmpty(frame)) return undefined
    const l = geometry.panelToLogical(px, py, logical)
    if (!l) return undefined
    const f = geometry.panelToFrame(px, py)
    if (!f) return undefined
    const [x, y] = l
    const [fx, fy] = f
    return { x, y, frameX: fx, frameY: fy, percentX: CoordinateMapper.percent(x, logical.width), percentY: CoordinateMapper.percent(y, logical.height), frameDiffers: !sizeEquals(logical, frame) }
  },

  /** Position of logical unit [value] in an extent of [size], in percent, from the unit's centre. */
  percent(value: number, size: number): number {
    return size <= 0 ? 0.0 : ((value + 0.5) * 100.0) / size
  },
}

/** The element under the cursor, from the last known hierarchy. */
export class ElementInfo {
  constructor(
    readonly description: string,
    readonly bounds: Rect,
  ) {}

  static of(node: UiNode | undefined | null): ElementInfo | undefined {
    const bounds = node?.bounds
    if (!node || !bounds) return undefined
    return new ElementInfo(node.displayLabel(), bounds)
  }
}

const one = (v: number): string => formatFixed(v, 1)

export const CoordinateText = {
  unit(platform: Platform | undefined): string {
    return platform === 'IOS' ? 'pt' : 'px'
  },

  /** "x, y", the form that pastes into a tap call. */
  xy(p: HoverPoint): string {
    return `${p.x}, ${p.y}`
  },

  /** "x%, y%" with one decimal. */
  percent(p: HoverPoint): string {
    return `${one(p.percentX)}%, ${one(p.percentY)}%`
  },

  size(e: ElementInfo): string {
    return `${e.bounds.width} x ${e.bounds.height}`
  },

  /** "x, y, w, h" in logical coordinates. */
  bounds(e: ElementInfo): string {
    return `${e.bounds.x}, ${e.bounds.y}, ${e.bounds.width}, ${e.bounds.height}`
  },

  /** The hover line under the mirror. [element] is undefined when no hierarchy is known or nothing is under the cursor. */
  infoLine(p: HoverPoint | undefined, platform: Platform | undefined, element: ElementInfo | undefined, hierarchyKnown: boolean): string {
    if (!p) return 'Move the mouse over the screen for coordinates'
    const parts = [`x ${p.x}, y ${p.y} ${CoordinateText.unit(platform)}`]
    if (p.frameDiffers) parts.push(`frame ${p.frameX}, ${p.frameY} px`)
    parts.push(CoordinateText.percent(p))
    if (element) parts.push(`${element.description}  ${CoordinateText.size(element)}`)
    else if (!hierarchyKnown) parts.push('no element info (open the inspector to load the hierarchy)')
    return parts.join('  |  ')
  },

  /** Label next to the crosshair. */
  crosshair(p: HoverPoint): string {
    return `${p.x}, ${p.y}`
  },
}

const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]

export const GridSteps = {
  MAX_LINES: 12,

  /** The smallest step that gives at most [MAX_LINES] lines along the longer side (about 8 to 12 on a phone). */
  choose(logical: Size): number {
    const longest = Math.max(logical.width, logical.height)
    return STEPS.find((it) => GridSteps.lines(longest, it).length <= GridSteps.MAX_LINES) ?? STEPS[STEPS.length - 1]
  },

  /** Grid positions inside (0, extent): step, 2 * step, ... */
  lines(extent: number, step: number): number[] {
    if (extent <= 0 || step <= 0) return []
    const out: number[] = []
    for (let v = step; v < extent; v += step) out.push(v)
    return out
  },
}
