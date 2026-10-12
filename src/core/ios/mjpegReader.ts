// ported-from: core/ios/MjpegReader.kt
import type { Readable } from 'node:stream'

/**
 * Splits a multipart MJPEG stream (as served by WebDriverAgent on port 9100 or `mobilecli screencapture`) into JPEG
 * frames. Frames are found by their JPEG start (FFD8) and end (FFD9) markers, so multipart headers and boundaries are
 * ignored. This keeps it robust against servers with sloppy headers.
 */
export class MjpegSplitter {
  private chunks: Buffer[] = []
  private size = 0
  private inFrame = false
  private previous = -1

  constructor(
    private readonly onFrame: (jpeg: Buffer) => void,
    private readonly maxFrameBytes = 16 * 1024 * 1024,
  ) {}

  push(buffer: Buffer): void {
    let segmentStart = 0
    for (let i = 0; i < buffer.length; i++) {
      const b = buffer[i]
      if (!this.inFrame) {
        if (this.previous === 0xff && b === 0xd8) {
          this.inFrame = true
          this.chunks = [Buffer.from([0xff, 0xd8])]
          this.size = 2
          segmentStart = i + 1
        }
      } else if (this.previous === 0xff && b === 0xd9) {
        this.chunks.push(buffer.subarray(segmentStart, i + 1))
        this.onFrame(Buffer.concat(this.chunks))
        this.inFrame = false
        this.chunks = []
        this.previous = -1
        continue
      }
      this.previous = b
    }
    if (this.inFrame) {
      const rest = buffer.subarray(segmentStart)
      this.chunks.push(rest)
      this.size += rest.length
      if (this.size > this.maxFrameBytes) {
        this.inFrame = false
        this.chunks = []
        this.size = 0
      }
    }
  }
}

/** Reads [input] until it ends or [shouldStop] returns true, calling [onFrame] for every complete JPEG. */
export function readMjpegFrames(input: Readable, onFrame: (jpeg: Buffer) => void, shouldStop: () => boolean = () => false): Promise<void> {
  return new Promise((resolve, reject) => {
    const splitter = new MjpegSplitter(onFrame)
    input.on('data', (chunk: Buffer) => {
      if (shouldStop()) {
        input.destroy()
        return resolve()
      }
      splitter.push(chunk)
    })
    input.on('end', resolve)
    input.on('close', resolve)
    input.on('error', reject)
  })
}
