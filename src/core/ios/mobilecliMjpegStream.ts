// ported-from: core/ios/MobilecliMjpegStream.kt
import type { ChildProcess } from 'node:child_process'
import { toFrame } from '../image/dimensions'
import type { FrameListener } from '../session/deviceSession'
import type { MobilecliClient } from './mobilecliClient'
import { readMjpegFrames } from './mjpegReader'

/** `mobilecli screencapture -f mjpeg` as a frame source, shared by the iOS and Android sessions. */
export class MobilecliMjpegStream {
  private running = false
  private process: ChildProcess | undefined

  constructor(
    private readonly mobilecli: MobilecliClient,
    private readonly id: string,
  ) {}

  /** [onEnd] runs once, never after [close]: the frames delivered and the error message (undefined when the stream just ended). */
  start(listener: FrameListener, onEnd: (frames: number, error: string | undefined) => void): void {
    this.running = true
    void (async () => {
      let frames = 0
      let error: string | undefined
      try {
        const started = this.mobilecli.startScreenStream(this.id)
        this.process = started
        // Drain stderr so a chatty process cannot block on a full pipe.
        started.stderr?.resume()
        const exited = new Promise<void>((resolve, reject) => {
          started.once('error', reject)
          started.once('close', () => resolve())
        })
        await Promise.all([
          exited,
          readMjpegFrames(
            started.stdout!,
            (jpeg) => {
              const frame = toFrame(jpeg)
              if (frame) {
                frames++
                listener.onFrame(frame)
              }
            },
            () => !this.running,
          ),
        ])
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      if (this.running) onEnd(frames, error)
    })()
  }

  close(): void {
    this.running = false
    this.process?.kill()
    this.process = undefined
  }
}
