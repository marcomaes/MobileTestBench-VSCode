// ported-from: core/inspector/Contrast.kt
import type { PixelReader } from '../image/pixels'
import { formatFixed } from '../javaFormat'
import type { Rect, Size } from '../model'

/** Pixel to dp conversion for Android: 1 dp is 1/160 inch, so dp = px * 160 / dpi. */
export const DpConverter = {
  toDp(px: number, densityDpi: number): number {
    return (px * 160.0) / densityDpi
  },

  /** "40", or "26.7" when the value is not (nearly) a whole number. */
  format(dp: number): string {
    return Math.abs(dp - Math.round(dp)) < 0.05 ? String(Math.round(dp)) : formatFixed(dp, 1)
  },
}

const channel = (c: number): number => {
  const s = c / 255.0
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG 2.2 contrast math (SC 1.4.3). Colors are 0xRRGGBB ints. */
export const Contrast = {
  luminance(rgb: number): number {
    return 0.2126 * channel((rgb >> 16) & 0xff) + 0.7152 * channel((rgb >> 8) & 0xff) + 0.0722 * channel(rgb & 0xff)
  },

  /** (L1 + 0.05) / (L2 + 0.05), lighter over darker: 1.0 to 21.0. */
  ratio(a: number, b: number): number {
    const la = Contrast.luminance(a)
    const lb = Contrast.luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  },

  hex(rgb: number): string {
    return '#' + (rgb & 0xffffff).toString(16).toUpperCase().padStart(6, '0')
  },
}

/** The estimated text and background colors of a region and their contrast ratio. */
export interface ContrastEstimate {
  readonly ratio: number
  readonly foreground: number
  readonly background: number
}

class Group {
  count = 0
  private r = 0
  private g = 0
  private b = 0

  add(p: number): void {
    this.count++
    this.r += (p >> 16) & 0xff
    this.g += (p >> 8) & 0xff
    this.b += p & 0xff
  }

  mean(): number {
    const half = Math.trunc(this.count / 2)
    return (Math.floor((this.r + half) / this.count) << 16) | (Math.floor((this.g + half) / this.count) << 8) | Math.floor((this.b + half) / this.count)
  }
}

/**
 * The groups in the order a java.util.HashMap<Int, _> iterates them (bucket index, then insertion order), because
 * ties on the group size are decided by that order in Kotlin (`maxByOrNull` keeps the first).
 */
function inHashMapOrder(groups: Map<number, Group>): Group[] {
  let capacity = 16
  while (groups.size > capacity * 0.75) capacity *= 2
  return [...groups.entries()]
    .map(([key, group], order) => ({ group, order, bucket: (key ^ (key >>> 16)) & (capacity - 1) }))
    .sort((a, b) => a.bucket - b.bucket || a.order - b.order)
    .map((it) => it.group)
}

const MIN_PIXELS = 24
const SHARE_FOR_PHOTO_CHECK = 0.02
const MAX_BIG_GROUPS = 12
const MIN_BACKGROUND_SHARE = 0.3
const MIN_FOREGROUND_SHARE = 0.005

/**
 * Estimates the text color and the background color of a region of a screen image with a quantised histogram:
 * pixels are grouped by their top 5 bits per channel, the background is the biggest group and the text color is
 * the group farthest from it in contrast. Groups are only used to find the pixels: the colors reported are the exact
 * mean of the pixels in the group (a group center can be 4 levels off, which moves a 4.6:1 text to 4.5).
 * This is a heuristic: photos and gradients, tiny regions and text that is almost the background color give undefined.
 */
export const ContrastSampler = {
  MAX_SAMPLES: 40_000,
  MIN_WIDTH: 12,
  MIN_HEIGHT: 8,
  MIN_PIXELS,

  /** Maps [bounds] (in the logical space [logical]) onto [frame] like ScreenshotAnnotator does and estimates it. */
  estimate(frame: PixelReader, logical: Size, bounds: Rect): ContrastEstimate | undefined {
    if (logical.width <= 0 || logical.height <= 0) return undefined
    // A frame with another aspect ratio than the logical space (rotation in progress): positions would be wrong.
    const frameAspect = frame.width / frame.height
    const logicalAspect = logical.width / logical.height
    if (Math.abs(frameAspect / logicalAspect - 1.0) > 0.02) return undefined
    const sx = frame.width / logical.width
    const sy = frame.height / logical.height
    const x0 = Math.max(0, Math.trunc(bounds.x * sx))
    const y0 = Math.max(0, Math.trunc(bounds.y * sy))
    const x1 = Math.min(frame.width, Math.trunc((bounds.x + bounds.width) * sx))
    const y1 = Math.min(frame.height, Math.trunc((bounds.y + bounds.height) * sy))
    const w = x1 - x0
    const h = y1 - y0
    if (w < ContrastSampler.MIN_WIDTH || h < ContrastSampler.MIN_HEIGHT || w * h < MIN_PIXELS) return undefined
    const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / ContrastSampler.MAX_SAMPLES)))
    const pixels: number[] = []
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) pixels.push(frame.getRgb(x, y) & 0xffffff)
    }
    return ContrastSampler.analyse(pixels)
  },

  analyse(rgbs: ArrayLike<number>): ContrastEstimate | undefined {
    if (rgbs.length < MIN_PIXELS) return undefined
    const groups = new Map<number, Group>()
    for (let i = 0; i < rgbs.length; i++) {
      const p = rgbs[i]
      const key = (((p >> 19) & 0x1f) << 10) | (((p >> 11) & 0x1f) << 5) | ((p >> 3) & 0x1f)
      let group = groups.get(key)
      if (!group) groups.set(key, (group = new Group()))
      group.add(p)
    }
    const total = rgbs.length
    const all = inHashMapOrder(groups)
    // A photo or a gradient has many sizeable color groups: no reliable text color.
    if (all.filter((it) => it.count >= total * SHARE_FOR_PHOTO_CHECK).length > MAX_BIG_GROUPS) return undefined
    let background: Group | undefined
    for (const g of all) if (background === undefined || g.count > background.count) background = g
    if (background === undefined || background.count < total * MIN_BACKGROUND_SHARE) return undefined
    const bg = background.mean()
    const minCount = Math.max(3.0, total * MIN_FOREGROUND_SHARE)
    const candidates = all.filter((it) => it !== background && it.count >= minCount).map((it) => ({ group: it, ratio: Contrast.ratio(bg, it.mean()) }))
    if (candidates.length === 0) return undefined
    const farthest = Math.max(...candidates.map((it) => it.ratio))
    // Most frequent among the (nearly) farthest: one stray anti-aliased pixel must not decide.
    let chosen: { group: Group; ratio: number } | undefined
    for (const c of candidates.filter((it) => it.ratio >= 1 + (farthest - 1) * 0.9)) if (chosen === undefined || c.group.count > chosen.group.count) chosen = c
    if (chosen === undefined) return undefined
    const fg = chosen.group.mean()
    return { ratio: Contrast.ratio(bg, fg), foreground: fg, background: bg }
  },
}
