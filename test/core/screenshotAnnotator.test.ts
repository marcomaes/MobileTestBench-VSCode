// ported-from: test:core/ScreenshotAnnotatorTest.kt
import { describe, expect, it } from 'vitest'
import { PixelImage } from '../../src/core/image/pixels'
import { rect } from '../../src/core/model'
import { ScreenshotAnnotator } from '../../src/core/screenshotAnnotator'

const WHITE = 0xffffffff | 0
const white = (w: number, h: number) => new PixelImage(w, h, WHITE)

describe('ScreenshotAnnotatorTest', () => {
  it('the outline is scaled from logical to frame pixels and the original is untouched', () => {
    const frame = white(200, 400)
    const result = ScreenshotAnnotator.outline(frame, { width: 100, height: 200 }, rect(10, 20, 30, 40)) // frame: 20,40 60x80
    expect(frame.getRgb(50, 80)).toBe(WHITE)
    expect(result.width).toBe(200)
    expect(result.getRgb(50, 80) & 0xffffff).not.toBe(0xffffff) // inside: tinted
    expect(result.getRgb(20, 80) & 0xffffff).not.toBe(0xffffff) // left edge: outline
    expect(result.getRgb(150, 300) & 0xffffff).toBe(0xffffff) // outside: unchanged
  })

  it('an unknown logical size leaves the image as it is', () => {
    const result = ScreenshotAnnotator.outline(white(10, 10), { width: 0, height: 0 }, rect(0, 0, 5, 5))
    expect(result.getRgb(2, 2) & 0xffffff).toBe(0xffffff)
  })
})
