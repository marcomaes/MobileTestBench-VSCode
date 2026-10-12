// No Kotlin counterpart: replaces java.awt.image.BufferedImage for the algorithms that need pixels (ImageDiff, ScreenshotAnnotator, Contrast).
import { PNG } from 'pngjs'
import * as jpeg from 'jpeg-js'
import { detectMime, type Frame } from './dimensions'

/** Read access to the pixels of an image. [getRgb] returns packed ARGB like `BufferedImage.getRGB` (a signed 32 bit int). */
export interface PixelReader {
  readonly width: number
  readonly height: number
  getRgb(x: number, y: number): number
}

/** A mutable image of packed ARGB ints (row major). */
export class PixelImage implements PixelReader {
  readonly data: Int32Array

  /** [rgb] fills the image (opaque unless it carries its own alpha). */
  constructor(
    readonly width: number,
    readonly height: number,
    rgb?: number,
  ) {
    this.data = new Int32Array(width * height)
    if (rgb !== undefined) this.data.fill(rgb | 0)
  }

  getRgb(x: number, y: number): number {
    return this.data[y * this.width + x]
  }

  setRgb(x: number, y: number, argb: number): void {
    this.data[y * this.width + x] = argb | 0
  }

  /** A copy with the same pixels. */
  copy(): PixelImage {
    const c = new PixelImage(this.width, this.height)
    c.data.set(this.data)
    return c
  }
}

/** Decodes PNG or JPEG bytes. Throws for anything else. */
export function decodeImage(data: Buffer): PixelImage {
  const mime = detectMime(data)
  let width: number
  let height: number
  let rgba: Uint8Array
  if (mime === 'image/png') {
    const png = PNG.sync.read(data)
    width = png.width
    height = png.height
    rgba = png.data
  } else if (mime === 'image/jpeg') {
    const j = jpeg.decode(data, { useTArray: true, formatAsRGBA: true })
    width = j.width
    height = j.height
    rgba = j.data
  } else {
    throw new Error('Not a PNG or JPEG image')
  }
  const out = new PixelImage(width, height)
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    out.data[i] = (rgba[p + 3] << 24) | (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]
  }
  return out
}

/** The pixels of a screen frame. */
export const decodeFrame = (frame: Frame): PixelImage => decodeImage(frame.data)

/** PNG bytes of [image]. */
export function encodePng(image: PixelReader): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  let p = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const v = image.getRgb(x, y)
      png.data[p++] = (v >> 16) & 0xff
      png.data[p++] = (v >> 8) & 0xff
      png.data[p++] = v & 0xff
      png.data[p++] = (v >>> 24) & 0xff
    }
  }
  return PNG.sync.write(png)
}
