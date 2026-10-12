// ported-from: core/visual/ImageDiff.kt
import { rect, type Rect, type Size } from '../model'
import { PixelImage, type PixelReader } from '../image/pixels'

/** Knobs of [ImageDiff.compare]. */
export interface DiffOptions {
  /** Largest per-channel (R, G, B) difference that still counts as equal, 0..255. */
  tolerance: number
  /** Forgive a pixel when it matches a neighbour (3x3) of the other image and the other way round: a text edge moved by 1px is not a change. */
  antiAliasing: boolean
  /** Block size for merging: changes in the same or neighbouring blocks of this many pixels end up in one region (so roughly 1 to 2*gap-1 px apart merge). */
  mergeGap: number
  /** A region with fewer changed pixels than this is noise and dropped. */
  minRegionPixels: number
}

export const DiffOptions = (o: Partial<DiffOptions> = {}): DiffOptions => ({ tolerance: 8, antiAliasing: true, mergeGap: 8, minRegionPixels: 4, ...o })

/** The outcome of a comparison of two same-sized images; regions are in image pixels. */
export class DiffResult {
  constructor(
    readonly size: Size,
    /** Row-major mask of the changed pixels that belong to a kept region. */
    readonly mask: boolean[],
    readonly changedPixels: number,
    readonly comparedPixels: number,
    readonly regions: Rect[],
  ) {}

  get percent(): number {
    return this.comparedPixels === 0 ? 0 : (this.changedPixels * 100) / this.comparedPixels
  }

  get matches(): boolean {
    return this.regions.length === 0
  }

  /** One line for the tab: "Match" or "3 regions, 1.25% changed". */
  verdict(): string {
    return this.matches
      ? 'Match: no differences'
      : `${this.regions.length} ${this.regions.length === 1 ? 'region' : 'regions'}, ${this.percent.toFixed(2)}% of the pixels changed`
  }
}

const RED = 0xffff0000 | 0

function pixels(img: PixelReader): Int32Array {
  if (img instanceof PixelImage) return img.data
  const out = new Int32Array(img.width * img.height)
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) out[y * img.width + x] = img.getRgb(x, y)
  return out
}

const close = (p: number, q: number, tol: number): boolean =>
  Math.abs(((p >> 16) & 0xff) - ((q >> 16) & 0xff)) <= tol && Math.abs(((p >> 8) & 0xff) - ((q >> 8) & 0xff)) <= tol && Math.abs((p & 0xff) - (q & 0xff)) <= tol

/** True when a[x,y] matches some pixel around b[x,y] and b[x,y] matches some pixel around a[x,y]. */
function forgiven(a: Int32Array, b: Int32Array, w: number, h: number, x: number, y: number, tol: number): boolean {
  const i = y * w + x
  let aInB = false
  let bInA = false
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const n = ny * w + nx
      if (!aInB && close(a[i], b[n], tol)) aInB = true
      if (!bInA && close(b[i], a[n], tol)) bInA = true
    }
  }
  return aInB && bInA
}

function fade(p: number): number {
  const r = (p >> 16) & 0xff
  const g = (p >> 8) & 0xff
  const b = p & 0xff
  // 35% of the colour, 65% white.
  const f = (c: number) => Math.round(c * 0.35 + 255 * 0.65)
  return (0xff << 24) | (f(r) << 16) | (f(g) << 8) | f(b)
}

/** Pure per-pixel image comparison. */
export const ImageDiff = {
  /** Undefined when the sizes differ: such images cannot be compared pixel by pixel. [ignore] rectangles (image pixels) are skipped. */
  compare(base: PixelReader, current: PixelReader, options: DiffOptions = DiffOptions(), ignore: Rect[] = []): DiffResult | undefined {
    if (base.width !== current.width || base.height !== current.height) return undefined
    const w = base.width
    const h = base.height
    const a = pixels(base)
    const b = pixels(current)
    const skip = new Array<boolean>(w * h).fill(false)
    for (const r of ignore) {
      for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.height); y++) {
        for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.width); x++) skip[y * w + x] = true
      }
    }
    const tol = Math.min(255, Math.max(0, options.tolerance))
    const changed = new Array<boolean>(w * h).fill(false)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (skip[i] || close(a[i], b[i], tol)) continue
        if (options.antiAliasing && forgiven(a, b, w, h, x, y, tol)) continue
        changed[i] = true
      }
    }
    const compared = skip.reduce((n, s) => n + (s ? 0 : 1), 0)
    const [regions, kept] = ImageDiff.cluster(changed, w, h, options.mergeGap, options.minRegionPixels)
    const count = kept.reduce((n, k) => n + (k ? 1 : 0), 0)
    return new DiffResult({ width: w, height: h }, kept, count, compared, regions)
  },

  /** The current image faded, with the changed pixels in red. */
  render(current: PixelReader, result: DiffResult): PixelImage {
    const w = result.size.width
    const h = result.size.height
    const out = new PixelImage(w, h)
    const src = pixels(current)
    for (let i = 0; i < src.length; i++) out.data[i] = result.mask[i] ? RED : fade(src[i])
    return out
  },

  /**
   * Merges nearby changed pixels: the image is cut in blocks of [gap] pixels, blocks that hold a changed pixel are joined with their
   * 8 neighbours, and each group gets the bounding box of its changed pixels. Groups under [minPixels] are dropped (and their pixels
   * removed from the returned mask).
   */
  cluster(changed: boolean[], w: number, h: number, gap: number, minPixels: number): [Rect[], boolean[]] {
    const block = Math.max(1, gap)
    const bw = Math.trunc((w + block - 1) / block)
    const bh = Math.trunc((h + block - 1) / block)
    const has = new Array<boolean>(bw * bh).fill(false)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (changed[y * w + x]) has[Math.trunc(y / block) * bw + Math.trunc(x / block)] = true
    const label = new Array<number>(bw * bh).fill(-1)
    let groups = 0
    const stack: number[] = []
    for (let start = 0; start < has.length; start++) {
      if (!has[start] || label[start] >= 0) continue
      label[start] = groups
      stack.push(start)
      while (stack.length) {
        const cur = stack.pop()!
        const cx = cur % bw
        const cy = Math.trunc(cur / bw)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue
            const n = ny * bw + nx
            if (has[n] && label[n] < 0) {
              label[n] = groups
              stack.push(n)
            }
          }
        }
      }
      groups++
    }
    const minX = new Array<number>(groups).fill(Number.MAX_SAFE_INTEGER)
    const minY = new Array<number>(groups).fill(Number.MAX_SAFE_INTEGER)
    const maxX = new Array<number>(groups).fill(-1)
    const maxY = new Array<number>(groups).fill(-1)
    const count = new Array<number>(groups).fill(0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!changed[y * w + x]) continue
        const g = label[Math.trunc(y / block) * bw + Math.trunc(x / block)]
        minX[g] = Math.min(minX[g], x)
        minY[g] = Math.min(minY[g], y)
        maxX[g] = Math.max(maxX[g], x)
        maxY[g] = Math.max(maxY[g], y)
        count[g]++
      }
    }
    const keep = count.map((c) => c >= minPixels)
    const kept = new Array<boolean>(w * h).fill(false)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (changed[y * w + x] && keep[label[Math.trunc(y / block) * bw + Math.trunc(x / block)]]) kept[y * w + x] = true
      }
    }
    const regions: Rect[] = []
    for (let g = 0; g < groups; g++) if (keep[g]) regions.push(rect(minX[g], minY[g], maxX[g] - minX[g] + 1, maxY[g] - minY[g] + 1))
    regions.sort((p, q) => p.y - q.y || p.x - q.x)
    return [regions, kept]
  },

  /** [rect] in the coordinate space of [from] expressed in [to] (frame pixels to logical coordinates or back). */
  scale(r: Rect, from: Size, to: Size): Rect {
    const empty = (s: Size) => s.width <= 0 || s.height <= 0
    if (empty(from) || empty(to) || (from.width === to.width && from.height === to.height)) return r
    const sx = to.width / from.width
    const sy = to.height / from.height
    // Kotlin roundToInt rounds half up.
    const round = (v: number) => Math.floor(v + 0.5)
    const x = round(r.x * sx)
    const y = round(r.y * sy)
    const right = round((r.x + r.width) * sx)
    const bottom = round((r.y + r.height) * sy)
    return rect(x, y, Math.max(1, right - x), Math.max(1, bottom - y))
  },
}
