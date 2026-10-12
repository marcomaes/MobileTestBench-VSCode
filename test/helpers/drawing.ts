// No Kotlin counterpart: the few java.awt calls (Graphics2D.fillRect, java.util.Random) the contrast tests use on a BufferedImage.
import { PixelImage } from '../../src/core/image/pixels'

/** `BufferedImage(w, h, TYPE_INT_RGB)` filled with [bg]. */
export const newImage = (w: number, h: number, bg = 0x000000): PixelImage => new PixelImage(w, h, 0xff000000 | bg)

/** `Graphics2D.fillRect`, clipped to the image like Java does. */
export function fillRect(img: PixelImage, color: number, x: number, y: number, w: number, h: number): void {
  const argb = 0xff000000 | color
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) img.setRgb(xx, yy, argb)
  }
}

/** java.util.Random (the 48 bit LCG), for the seeded noise image of the Kotlin test. */
export class JavaRandom {
  private seed: bigint
  constructor(seed: number) {
    this.seed = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n)
  }
  private next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n)
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }
  nextInt(bound: number): number {
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    let bits: number
    let val: number
    do {
      bits = this.next(31)
      val = bits % bound
    } while (bits - val + (bound - 1) > 0x7fffffff)
    return val
  }
}
