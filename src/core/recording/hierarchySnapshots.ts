// ported-from: core/recording/HierarchySnapshots.kt
import type { UiNode } from '../inspector/uiNode'

type Outcome = { ok: true; root: UiNode } | { ok: false; error: unknown }
interface Snapshot {
  readonly epoch: number
  readonly result: Outcome
}

/** [fresh] is false when the hierarchy was captured before the latest input. */
export interface Captured {
  readonly root: UiNode
  readonly fresh: boolean
}

const now = (): number => performance.now()

/**
 * Keeps a recent hierarchy ready while recording, so a tap does not have to wait for a dump.
 *
 * A background loop captures the hierarchy once the device has been quiet for [settleMs] after the
 * last input that changed the screen, and again every [idleMs] while nothing happens (the screen may
 * change by itself). A snapshot taken after the latest such input is "fresh": it shows the screen the
 * user is looking at. Dumps can be slow (mobilecli: 0.1 to 5 s, sometimes much more), so [awaitFresh]
 * waits only a short time for a fresh one and then settles for the newest older snapshot, flagged as stale.
 *
 * Call [inputDone] after each input that can change the screen (tap, swipe, Enter, Home, Back; typing keeps
 * the layout and needs no call); [awaitFresh] before recording the next one.
 * (The Kotlin class runs on a daemon thread with a monitor; here it is one async loop and a list of waiters.)
 */
export class HierarchySnapshots {
  private epoch = 0
  private lastInputDoneAt = 0
  private snapshot: Snapshot | undefined
  private lastGood: UiNode | undefined
  private lastFailure: unknown
  private closed = false
  private started = false
  private waiters: Array<() => void> = []

  constructor(
    private readonly capture: () => Promise<UiNode>,
    private readonly settleMs = 300,
    private readonly idleMs = 1000,
    private readonly retryMs = 300,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    void this.loop()
  }

  /** The input just sent changes the screen: older snapshots are no longer valid. */
  inputDone(): void {
    this.epoch++
    this.lastInputDoneAt = now()
    this.notifyAll()
  }

  /** The newest successful capture, whatever its age, without waiting. Undefined before the first one. */
  latest(): UiNode | undefined {
    return this.lastGood
  }

  /**
   * The hierarchy for a tap: a fresh one if it arrives within [freshWaitMs], otherwise the newest older one
   * (stale). With none at all it keeps waiting up to [maxWaitMs] and then throws, naming the last capture error.
   */
  async awaitFresh(freshWaitMs: number, maxWaitMs: number): Promise<Captured> {
    const started = now()
    for (;;) {
      const s = this.snapshot
      if (s && s.epoch === this.epoch && s.result.ok) return { root: s.result.root, fresh: true }
      if (this.closed) throw new Error('Recording stopped')
      const waited = now() - started
      const stale = this.lastGood
      if (waited >= freshWaitMs && stale) return { root: stale, fresh: false }
      if (waited >= maxWaitMs) {
        const failure = this.lastFailure
        throw new Error(failure instanceof Error ? failure.message : failure !== undefined ? String(failure) : `No hierarchy within ${Math.trunc(maxWaitMs / 1000)} s`)
      }
      await this.wait(Math.max(1, Math.min(stale ? freshWaitMs - waited : maxWaitMs - waited, maxWaitMs - waited)))
    }
  }

  close(): void {
    this.closed = true
    this.notifyAll()
  }

  private async loop(): Promise<void> {
    for (;;) {
      while (!this.closed) {
        const wait = this.lastInputDoneAt + this.settleMs - now()
        if (wait <= 0) break
        await this.wait(wait)
      }
      if (this.closed) return
      const startEpoch = this.epoch
      let result: Outcome
      try {
        result = { ok: true, root: await this.capture() }
      } catch (e) {
        result = { ok: false, error: e }
      }
      this.snapshot = { epoch: startEpoch, result }
      if (result.ok) {
        this.lastGood = result.root
        this.lastFailure = undefined
      } else this.lastFailure = result.error
      this.notifyAll()
      const until = now() + (result.ok ? this.idleMs : this.retryMs)
      while (!this.closed && this.epoch === startEpoch) {
        const remaining = until - now()
        if (remaining <= 0) break
        await this.wait(remaining)
      }
      if (this.closed) return
    }
  }

  /** Resolves when [notifyAll] is called or after [ms], whichever comes first. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      const self = this
      function done(): void {
        clearTimeout(timer)
        self.waiters = self.waiters.filter((w) => w !== done)
        resolve()
      }
      this.waiters.push(done)
    })
  }

  private notifyAll(): void {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }
}
