// ported-from: core/session/PollingFrameSource.kt
import type { Frame } from '../image/dimensions'
import type { FrameListener } from './deviceSession'

/**
 * Fallback stream: grabs a screenshot in a loop. Slow (a few FPS) but works for every Android device and every
 * booted iOS simulator without extra tooling.
 */
export class PollingFrameSource {
  private running = false
  paused = false

  constructor(
    private readonly minIntervalMs: number,
    private readonly grab: () => Promise<Frame | undefined>,
  ) {}

  start(listener: FrameListener): void {
    if (this.running) return
    this.running = true
    void this.loop(listener)
  }

  private async loop(listener: FrameListener): Promise<void> {
    let consecutiveErrors = 0
    while (this.running) {
      const started = Date.now()
      if (!this.paused) {
        try {
          const frame = await this.grab()
          if (frame && this.running) listener.onFrame(frame)
          consecutiveErrors = 0
        } catch (e) {
          consecutiveErrors++
          if (consecutiveErrors === 3) listener.onError(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`, e)
        }
      }
      const wait = Math.max(this.minIntervalMs - (Date.now() - started), 0) + (consecutiveErrors > 0 ? 1000 : 0)
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  close(): void {
    this.running = false
  }
}
