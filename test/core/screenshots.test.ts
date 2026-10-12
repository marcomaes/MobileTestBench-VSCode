// No Kotlin counterpart: the extension's screenshot helpers (turning upright frames, file names).
import { describe, expect, it } from 'vitest'
import { PixelImage, decodeImage, encodePng } from '../../src/core/image/pixels'
import { fileStamp, rotateCounterClockwise, screenshotPng } from '../../src/extension/screenshots'

describe('screenshots', () => {
  it('rotates counter-clockwise', () => {
    const img = new PixelImage(2, 3)
    for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) img.setRgb(x, y, (0xff << 24) | (y * 2 + x))
    const r = rotateCounterClockwise(img)
    expect(r.width).toBe(3)
    expect(r.height).toBe(2)
    // top-left of the source ends up bottom-left, top-right ends up top-left
    expect(r.getRgb(0, 1) & 0xffffff).toBe(0)
    expect(r.getRgb(0, 0) & 0xffffff).toBe(1)
    expect(r.getRgb(2, 1) & 0xffffff).toBe(4)
  })

  it('keeps a png frame as it is and turns it when upright', () => {
    const img = new PixelImage(2, 4)
    const data = encodePng(img)
    const frame = { data, mime: 'image/png' as const, width: 2, height: 4 }
    expect(screenshotPng(frame, false, undefined)).toBe(data)
    const turned = decodeImage(screenshotPng(frame, true, undefined))
    expect([turned.width, turned.height]).toEqual([4, 2])
  })

  it('names files with the device and the local time', () => {
    expect(fileStamp('Pixel 9 (emu)', 'png', new Date(2026, 0, 2, 3, 4, 5))).toBe('Pixel-9-emu--20260102-030405.png')
    expect(fileStamp(undefined, 'mp4', new Date(2026, 11, 31, 23, 59, 59))).toBe('device-20261231-235959.mp4')
  })
})
