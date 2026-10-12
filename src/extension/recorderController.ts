// ported-from: ui/RecorderPanel.kt
// ported-from: ui/DeviceViewerPanel.kt
// The recorder logic that the Kotlin DeviceViewerPanel keeps next to the RecorderPanel: setRecording, setAssertArmed, pickAssertion,
// startReplay, setStepTimeout, scrollUntilVisible, setScrollOptions, clearRecording and the row model of the panel. No vscode import:
// everything the UI has to do (menus, input boxes, the editor) is injected, so it is unit tested with fakes.
import type { Captured } from '../core/recording/hierarchySnapshots'
import { Checks, CountIs, type Check } from '../core/recording/assertion'
import { RecorderOutput } from '../core/recording/appiumSteps'
import { ReplayOptions, type IntRange } from '../core/recording/replayOptions'
import { ScriptPlayer, type ScriptPlayerState } from '../core/recording/scriptPlayer'
import { ScriptRecorder } from '../core/recording/scriptRecorder'
import type { UiNode } from '../core/inspector/uiNode'
import type { Platform } from '../core/model'
import type { DeviceSession } from '../core/session/deviceSession'
import { recordGesture, type GestureListener } from './gestures'

/** What the controller needs from the viewer (a subset of ToolContext.viewer). */
export interface RecorderViewer {
  onGesture(listener: GestureListener): () => void
  startSnapshots(): void
  stopSnapshots(): void
  awaitSnapshot(): Promise<Captured>
  blockInput(reason: string | undefined): void
}

export interface RecorderDeps {
  viewer: RecorderViewer
  session(): DeviceSession | undefined
  settings(): { recorderOutput: string; replayTimeoutSeconds: number; replayDelayMs: number }
  saveOutput(name: string): void
  emit(view: RecorderView): void
  /** The Assert menu (Kotlin showAssertionMenu). Undefined when cancelled. */
  choose(title: string, options: Check[]): Promise<Check | undefined>
  /** The count prompt, prefilled; undefined when cancelled. */
  askCount(proposed: number): Promise<number | undefined>
  /** Timeout in seconds for the selected steps: a number, null to remove it, undefined when cancelled. */
  askTimeout(currentSeconds: number | undefined): Promise<number | null | undefined>
  /** Direction and swipe limit of a scroll step; undefined when cancelled. */
  askScroll(direction: string, maxSwipes: number): Promise<{ direction: string; maxSwipes: number } | undefined>
  notify(message: string): void
}

export interface RowView {
  text: string
  state?: ScriptPlayerState
  isSwipe: boolean
  isScroll: boolean
  supportsTimeout: boolean
}

/** What the Recorder tab draws; sent to the webview after every change. */
export interface RecorderView {
  recording: boolean
  replaying: boolean
  armed: boolean
  output: string
  outputs: Array<{ value: string; label: string }>
  platform: Platform
  rows: RowView[]
  message: string
  canReplay: boolean
  code: string
}

const FIRST_LINE = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split(/\r\n|\r|\n/)[0]

export class RecorderController {
  private recorder: ScriptRecorder | undefined
  private recording = false
  private replaying = false
  private armed = false
  private unsubscribe: (() => void) | undefined
  private states: Array<ScriptPlayerState | undefined> = []
  private message = ' '
  private platform: Platform = 'ANDROID'

  constructor(private readonly deps: RecorderDeps) {}

  get isRecording(): boolean {
    return this.recording
  }
  get isReplaying(): boolean {
    return this.replaying
  }
  get isArmed(): boolean {
    return this.armed
  }

  private output(): RecorderOutput {
    return RecorderOutput.fromName(this.deps.settings().recorderOutput)
  }

  private steps(): readonly ScriptRecorder.Step[] {
    return this.recorder?.steps ?? []
  }

  /** The recorded steps as code in the chosen output (Copy and Insert). */
  code(): string {
    return this.output().render(this.steps(), this.recorder?.platform ?? this.platform)
  }

  view(): RecorderView {
    const output = this.output()
    const platform = this.recorder?.platform ?? this.platform
    const steps = this.steps()
    return {
      recording: this.recording,
      replaying: this.replaying,
      armed: this.armed,
      output: output.name,
      outputs: RecorderOutput.entries.map((o) => ({ value: o.name, label: o.label })),
      platform,
      rows: steps.map((step, i) => ({
        text: output.summary(step, platform),
        state: this.states[i],
        isSwipe: step instanceof ScriptRecorder.Swipe,
        isScroll: step instanceof ScriptRecorder.ScrollUntilVisible,
        supportsTimeout: ReplayOptions.supportsTimeout(step),
      })),
      message: this.message,
      canReplay: steps.length > 0 && !this.recording && !this.replaying,
      code: this.code(),
    }
  }

  private changed(message?: string): void {
    if (message !== undefined) this.message = message
    this.deps.emit(this.view())
  }

  private resetStates(): void {
    this.states = []
  }

  // region recording

  /** Kotlin `setRecording`. Starting needs a session with input and no replay. */
  setRecording(enabled: boolean): void {
    const session = this.deps.session()
    if (enabled && (!session || !session.supportsInput || this.replaying)) {
      this.changed(!session ? 'Connect to a device first' : this.replaying ? 'A replay is running: press Stop first' : 'Input is not available for this device')
      return
    }
    if (enabled === this.recording) return
    this.recording = enabled
    if (!enabled) this.armed = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.deps.viewer.stopSnapshots()
    if (enabled) {
      const platform = session!.device.platform
      if (!this.recorder || this.recorder.platform !== platform) {
        this.recorder = new ScriptRecorder(platform)
        this.resetStates()
      }
      this.platform = platform
      this.deps.viewer.startSnapshots()
      // The listener runs on the viewer's input queue before the input is sent, so steps keep their order.
      this.unsubscribe = this.deps.viewer.onGesture((g) => (this.recording && this.recorder ? this.recordAndShow(g) : undefined))
    }
    this.changed(enabled ? 'Recording...' : ' ')
  }

  private async recordAndShow(gesture: Parameters<GestureListener>[0]): Promise<void> {
    const rec = this.recorder
    if (!rec) return
    await recordGesture(rec, gesture, () => this.deps.viewer.awaitSnapshot())
    if (this.recorder === rec && this.recording) {
      this.resetStates()
      this.changed()
    }
  }

  /** Kotlin `setAssertArmed`. */
  setArmed(armed: boolean): void {
    this.armed = armed && this.recording
    this.changed(this.armed ? 'Click an element on the screen to assert on it' : ' ')
  }

  /** The user clicked an element while Assert is on (Kotlin `pickAssertion`): find it and offer the assertions that fit. */
  async pick(x: number, y: number): Promise<void> {
    const rec = this.recorder
    if (!rec || !this.recording) return
    let root: UiNode
    try {
      root = (await this.deps.viewer.awaitSnapshot()).root
    } catch (e) {
      this.changed(`No hierarchy yet: ${FIRST_LINE(e)}`)
      return
    }
    const picked = rec.pick(root, x, y)
    if (!picked) {
      this.changed('No element with a locator there; click another one')
      return
    }
    let check = await this.deps.choose(`Assert on ${picked.target.code()}`, Checks.optionsFor(picked.node, picked.matchCount))
    if (check instanceof CountIs) {
      const count = await this.deps.askCount(check.count)
      check = count === undefined ? undefined : new CountIs(count)
    }
    if (check) {
      rec.add(picked.target, check)
      this.resetStates()
    }
    this.armed = false
    this.changed(' ')
  }

  // endregion

  // region list edits (Kotlin: run on the input executor while recording, so they never interleave with a step)

  clear(): void {
    this.recorder?.clear()
    this.resetStates()
    this.changed(' ')
  }

  setOutput(name: string): void {
    this.deps.saveOutput(RecorderOutput.fromName(name).name)
    this.deps.emit({ ...this.view(), output: RecorderOutput.fromName(name).name })
  }

  scrollUntilVisible(rows: number[]): void {
    if (this.replaying || !this.recorder) return
    const problem = this.recorder.scrollUntilVisible(rows)
    this.resetStates()
    this.changed(problem ?? 'Swipes replaced by scroll until visible')
  }

  async askScroll(rows: number[]): Promise<void> {
    const rec = this.recorder
    if (this.replaying || !rec) return
    const steps = rows.map((i) => rec.steps[i])
    if (steps.length === 0 || !steps.every((s) => s instanceof ScriptRecorder.ScrollUntilVisible)) return
    const first = steps[0] as ScriptRecorder.ScrollUntilVisible
    const answer = await this.deps.askScroll(first.direction, first.maxSwipes)
    if (!answer) return
    const changed = rows.filter((it) => rec.setScrollOptions(it, answer.direction, answer.maxSwipes)).length
    this.changed(changed === 0 ? 'Only scroll until visible steps have a direction and limit' : `Scroll set to ${answer.direction}, at most ${answer.maxSwipes} swipes`)
  }

  async askTimeout(rows: number[]): Promise<void> {
    const rec = this.recorder
    if (this.replaying || !rec || rows.length === 0) return
    const steps = rows.map((i) => rec.steps[i])
    if (!steps.every((s) => s !== undefined && ReplayOptions.supportsTimeout(s))) return
    const current = steps.map((s) => ReplayOptions.timeoutOf(s)).find((t) => t !== undefined)
    const seconds = await this.deps.askTimeout(current === undefined ? undefined : ReplayOptions.wholeSeconds(current))
    if (seconds === undefined) return
    this.setTimeout(rows, seconds === null ? undefined : seconds * 1000)
  }

  /** Sets (or with undefined removes) the own timeout of the wait and expect steps at [rows]. */
  setTimeout(rows: number[], timeoutMs: number | undefined): void {
    if (this.replaying || !this.recorder) return
    const rec = this.recorder
    const changed = rows.filter((it) => rec.setTimeout(it, timeoutMs)).length
    this.resetStates()
    this.changed(
      changed === 0 ? 'Only wait and expect steps have a timeout' : timeoutMs === undefined ? 'Timeout removed: the replay timeout setting applies' : `Timeout set to ${ReplayOptions.format(timeoutMs)}`,
    )
  }

  // endregion

  // region replay

  /** [range] is the steps to run (indices in the recording); undefined runs all of them (Kotlin `startReplay`). */
  async replay(range?: IntRange): Promise<void> {
    const session = this.deps.session()
    const steps = [...this.steps()]
    if (!session || this.recording || this.replaying || steps.length === 0 || !session.supportsInput) return
    if (this.recorder?.platform !== session.device.platform) {
      this.deps.notify(`This recording is for ${this.recorder?.platform}; connect a ${this.recorder?.platform} device to replay it`)
      return
    }
    this.replaying = true
    this.deps.viewer.blockInput('A replay is running: press Stop first')
    this.resetStates()
    this.changed(' ')
    let passed = false
    try {
      const settings = this.deps.settings()
      const player = new ScriptPlayer(session, { elementTimeoutMs: ReplayOptions.timeoutMs(settings.replayTimeoutSeconds), stepDelayMs: ReplayOptions.delayMs(settings.replayDelayMs) })
      passed = await player.run(
        steps,
        (index, state, message) => {
          this.states[index] = state
          if (state === 'RUNNING') this.changed(`Replaying step ${index + 1} of ${steps.length}`)
          else if (state === 'FAILED') this.changed(`Step ${index + 1} failed: ${message ?? ''}`)
          else this.changed()
        },
        () => !this.replaying,
        range,
      )
    } finally {
      const stopped = !this.replaying
      this.replaying = false
      this.deps.viewer.blockInput(undefined)
      this.changed(passed ? 'Replay finished: all steps passed' : stopped ? 'Replay stopped' : this.message)
    }
  }

  /** The Stop button of a running replay. */
  stopReplay(): void {
    this.replaying = false
  }

  // endregion

  /** The viewer closed or the session ended. */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.replaying = false
    if (this.recording) this.deps.viewer.stopSnapshots()
    this.recording = false
    this.armed = false
    this.deps.viewer.blockInput(undefined)
  }
}
