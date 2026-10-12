// ported-from: test:core/ContrastTest.kt
import { describe, expect, it } from 'vitest'
import { AdbOutput } from '../../src/core/android/adbClient'
import type { PixelImage } from '../../src/core/image/pixels'
import { Contrast, ContrastSampler, DpConverter } from '../../src/core/inspector/contrast'
import { rect, size } from '../../src/core/model'
import { fillRect, JavaRandom, newImage } from '../helpers/drawing'

/** A flat [bg] image with [fg] stripes standing in for text, covering about 10 percent. */
function textImage(w: number, h: number, fg: number, bg: number): PixelImage {
  const img = newImage(w, h, bg)
  let x = 4
  while (x < w - 4) {
    fillRect(img, fg, x, Math.trunc(h / 3), 3, Math.trunc(h / 3))
    x += 30
  }
  return img
}

// JUnit assertEquals(expected, actual, delta).
const near = (actual: number, expected: number, delta: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(delta)

describe('ContrastTest', () => {
  it('wcag ratio of known colors', () => {
    near(Contrast.ratio(0x000000, 0xffffff), 21.0, 0.001)
    near(Contrast.ratio(0x777777, 0x777777), 1.0, 0.001)
    near(Contrast.ratio(0x777777, 0xffffff), 4.48, 0.01)
    near(Contrast.ratio(0x757575, 0xffffff), 4.61, 0.01)
    expect(Math.abs(Contrast.ratio(0x123456, 0xfedcba) - Contrast.ratio(0xfedcba, 0x123456))).toBeLessThan(1e-12)
    expect(Contrast.hex(0x00ff0a)).toBe('#00FF0A')
  })

  it('dp conversion', () => {
    near(DpConverter.toDp(105, 420), 40.0, 1e-9)
    near(DpConverter.toDp(63, 420), 24.0, 1e-9)
    expect(DpConverter.format(40.0)).toBe('40')
    expect(DpConverter.format(DpConverter.toDp(71, 420) * 0 + 26.93)).toBe('26.9')
  })

  it('parses wm density and lets an override win', () => {
    expect(AdbOutput.parseWmDensity('Physical density: 420\n')).toBe(420)
    expect(AdbOutput.parseWmDensity('Physical density: 420\nOverride density: 320\n')).toBe(320)
    expect(AdbOutput.parseWmDensity('error: device offline')).toBeUndefined()
  })

  it('measures a known contrast with the exact colors', () => {
    const img = textImage(200, 40, 0x757575, 0xffffff)
    const e = ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 200, 40))!
    expect(e.foreground).toBe(0x757575)
    expect(e.background).toBe(0xffffff)
    near(e.ratio, 4.61, 0.01)
  })

  it('low and high contrast text', () => {
    const low = ContrastSampler.estimate(textImage(200, 40, 0xb0b0b0, 0xffffff), size(200, 40), rect(0, 0, 200, 40))!
    near(low.ratio, 2.17, 0.02)
    const dark = ContrastSampler.estimate(textImage(200, 40, 0xffffff, 0x202020), size(200, 40), rect(0, 0, 200, 40))!
    expect(dark.ratio).toBeGreaterThan(14)
    expect(dark.foreground).toBe(0xffffff)
  })

  it('maps logical bounds onto a frame with another resolution', () => {
    // 3x frame: the left half is dark on white text-like stripes, the right half is a flat color.
    const img = newImage(600, 120, 0xffffff)
    for (let x = 10; x < 290; x += 40) fillRect(img, 0x999999, x, 40, 6, 40)
    const left = ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 100, 40))!
    expect(left.foreground).toBe(0x999999)
    expect(ContrastSampler.estimate(img, size(200, 40), rect(110, 0, 90, 40)), 'flat region has no text').toBeUndefined()
  })

  it('skips photos gradients tiny regions and mismatching frames', () => {
    const gradient = newImage(256, 40)
    for (let x = 0; x < 256; x++) for (let y = 0; y < 40; y++) gradient.setRgb(x, y, 0xff000000 | (x << 16) | (x << 8) | x)
    expect(ContrastSampler.estimate(gradient, size(256, 40), rect(0, 0, 256, 40))).toBeUndefined()
    const noise = newImage(100, 100)
    const r = new JavaRandom(1)
    for (let x = 0; x < 100; x++) for (let y = 0; y < 100; y++) noise.setRgb(x, y, 0xff000000 | r.nextInt(0xffffff))
    expect(ContrastSampler.estimate(noise, size(100, 100), rect(0, 0, 100, 100))).toBeUndefined()
    const img = textImage(200, 40, 0, 0xffffff)
    expect(ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 10, 40)), 'too small').toBeUndefined()
    expect(ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 200, 6)), 'too flat in height').toBeUndefined()
    expect(ContrastSampler.estimate(img, size(40, 200), rect(0, 0, 40, 100)), 'aspect differs from the logical size (rotation)').toBeUndefined()
    expect(ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 200, 40))).toBeDefined()
  })

  it('an almost invisible text color is not estimated', () => {
    expect(ContrastSampler.estimate(textImage(200, 40, 0xfafafa, 0xffffff), size(200, 40), rect(0, 0, 200, 40))).toBeUndefined()
  })

  it('stray anti aliased pixels do not decide the text color', () => {
    const img = textImage(200, 40, 0x333333, 0xffffff)
    for (let i = 0; i < 3; i++) img.setRgb(100 + i, 2, 0xff000000) // three pixels in a different group, below the share limit
    const e = ContrastSampler.estimate(img, size(200, 40), rect(0, 0, 200, 40))!
    expect(e.foreground).toBe(0x333333)
  })
})
