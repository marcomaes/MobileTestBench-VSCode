// ported-from: test:core/StreamAndGeometryTest.kt
import { describe, expect, it } from 'vitest'
import { MjpegSplitter } from '../../src/core/ios/mjpegReader'
import { rect, size } from '../../src/core/model'
import { ScreenGeometry } from '../../src/core/screenGeometry'

const fakeJpeg = (seed: number): Buffer => Buffer.from([0xff, 0xd8, seed, 0x11, 0xff, 0x00, 0x22, 0xff, 0xd9])

describe('stream and geometry', () => {
  it('splits mjpeg multipart stream into frames', () => {
    const frames = [fakeJpeg(1), fakeJpeg(2), fakeJpeg(3)]
    const body = Buffer.concat(
      frames.flatMap((f) => [Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from('\r\n')]),
    )
    for (const chunk of [1, 2, 3, 7, 4096]) {
      const received: Buffer[] = []
      const splitter = new MjpegSplitter((f) => received.push(f))
      for (let i = 0; i < body.length; i += chunk) splitter.push(body.subarray(i, i + chunk))
      expect(received, `chunk=${chunk}`).toHaveLength(3)
      frames.forEach((f, i) => expect([...received[i]], `chunk=${chunk}`).toEqual([...f]))
    }
  })

  it('maps panel to logical coordinates with retina frames', () => {
    // iOS: 1170x2532 pixel frame, 390x844 point logical space, drawn in a 400x900 panel.
    const geometry = new ScreenGeometry(size(400, 900), size(1170, 2532), 0)
    const logical = size(390, 844)
    const r = geometry.imageRect
    expect(r.width <= 400 && r.height <= 900).toBe(true)
    const [x, y] = geometry.panelToLogical(r.x + Math.trunc(r.width / 2), r.y + Math.trunc(r.height / 2), logical)!
    expect(Math.abs(x - 195)).toBeLessThanOrEqual(2)
    expect(Math.abs(y - 422)).toBeLessThanOrEqual(2)
    if (r.x > 0) expect(geometry.panelToLogical(0, 0, logical)).toBeUndefined()
    expect(geometry.logicalToPanel(rect(0, 0, 390, 844), logical)).toEqual(r)
  })
})
