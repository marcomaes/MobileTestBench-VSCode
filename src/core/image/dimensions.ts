// No Kotlin counterpart: replaces ImageIO.read(...).width/height for frames, so core needs no image decoder to size a frame.
import type { Size } from '../model'

export type FrameMime = 'image/png' | 'image/jpeg'

/** A screen frame as encoded bytes (PNG from screenshots and gRPC, JPEG from MJPEG), sized without decoding it. */
export interface Frame {
  readonly data: Buffer
  readonly mime: FrameMime
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function detectMime(data: Uint8Array): FrameMime | undefined {
  if (data.length > 8 && PNG_SIGNATURE.every((b, i) => data[i] === b)) return 'image/png'
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  return undefined
}

/** Pixel size read from the PNG IHDR chunk or the JPEG start-of-frame marker; undefined for anything else. */
export function imageSize(data: Buffer): Size | undefined {
  const mime = detectMime(data)
  if (mime === 'image/png') {
    if (data.length < 24) return undefined
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (mime === 'image/jpeg') {
    let i = 2
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i++
        continue
      }
      const marker = data[i + 1]
      if (marker === 0xff) {
        i++
        continue
      }
      // Start of frame markers (baseline, extended, progressive, ...) except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      i += 2 + data.readUInt16BE(i + 2)
    }
  }
  return undefined
}

/** Wraps encoded image bytes as a [Frame], or undefined when they are not a PNG or JPEG. */
export function toFrame(data: Buffer): Frame | undefined {
  const mime = detectMime(data)
  const s = mime ? imageSize(data) : undefined
  return mime && s ? { data, mime, width: s.width, height: s.height } : undefined
}
