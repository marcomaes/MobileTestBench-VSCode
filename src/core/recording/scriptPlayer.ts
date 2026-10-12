// ported-from: core/recording/ScriptPlayer.kt
import { rectCenterX, rectCenterY } from '../model'
import type { UiNode } from '../inspector/uiNode'
import { UnsupportedOperationOnDevice, type DeviceSession } from '../session/deviceSession'
import { Assertion } from './assertion'
import { ReplayOptions, type IntRange } from './replayOptions'
import { ScriptRecorder } from './scriptRecorder'
import { ScrollUntilVisible } from './scrollUntilVisible'
import { TextClearing } from './textClearing'

type Step = ScriptRecorder.Step

class StepFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepFailed'
  }
}

/** How often the field is read back after clearing, in case the keyboard is slow to apply the keys. */
const CLEAR_CHECKS = 3
const DELAY_SLICE_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `e.message?.lineSequence()?.firstOrNull()` as it prints in a Kotlin string template. */
function firstLine(e: unknown): string {
  const message = e instanceof Error ? e.message : undefined
  return message === undefined ? 'null' : message.split(/\r\n|\r|\n/)[0]
}

export type ScriptPlayerState = 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED'

export type ScriptPlayerListener = (index: number, state: ScriptPlayerState, message: string | undefined) => void

export interface ScriptPlayerOptions {
  readonly elementTimeoutMs?: number
  readonly pollMs?: number
  /** Slow motion: pause between two replayed steps. */
  readonly stepDelayMs?: number
  /** How the pause is spent; the default sleeps. Tests inject a fake. */
  readonly pause?: (ms: number) => void | Promise<void>
}

/**
 * Replays recorded steps on a device. Like Mobilewright, every step that targets an element waits for it
 * to show up (up to [elementTimeoutMs]) and then acts on its center; the first failure stops the run.
 * Async here: every device call is awaited.
 */
export class ScriptPlayer {
  static readonly State = { RUNNING: 'RUNNING', PASSED: 'PASSED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' } as const

  private readonly elementTimeoutMs: number
  private readonly pollMs: number
  private readonly stepDelayMs: number
  private readonly pause: (ms: number) => void | Promise<void>

  constructor(
    private readonly session: DeviceSession,
    options: ScriptPlayerOptions = {},
  ) {
    this.elementTimeoutMs = options.elementTimeoutMs ?? 10_000
    this.pollMs = options.pollMs ?? 500
    this.stepDelayMs = options.stepDelayMs ?? 0
    this.pause = options.pause ?? sleep
  }

  /**
   * True when every step passed or was skipped. [cancelled] is polled between steps and while waiting. Only the steps in
   * [range] (default all) run; the listener always gets the index in [steps]. [stepDelayMs] is waited between two steps
   * that run, not before the first one.
   */
  async run(steps: readonly Step[], listener: ScriptPlayerListener, cancelled: () => boolean = () => false, range?: IntRange): Promise<boolean> {
    const indices: number[] = []
    const first = range?.first ?? 0
    const last = range?.last ?? steps.length - 1
    for (let i = first; i <= last; i++) if (i >= 0 && i < steps.length) indices.push(i)
    let ran = false
    for (const index of indices) {
      const step = steps[index]
      if (cancelled()) return false
      if (step instanceof ScriptRecorder.Note || step instanceof ScriptRecorder.UnfocusedText) {
        listener(index, 'SKIPPED', 'Comment: nothing to replay')
        continue
      }
      if (ran && this.stepDelayMs > 0 && !(await this.delay(cancelled))) return false
      ran = true
      listener(index, 'RUNNING', undefined)
      try {
        await this.perform(step, cancelled)
        listener(index, 'PASSED', undefined)
      } catch (e) {
        const message = e instanceof Error ? e.message || e.name : String(e)
        listener(index, 'FAILED', message)
        return false
      }
    }
    return true
  }

  /** Waits [stepDelayMs] in small slices; false when cancelled meanwhile. */
  private async delay(cancelled: () => boolean): Promise<boolean> {
    let left = this.stepDelayMs
    while (left > 0) {
      if (cancelled()) return false
      const slice = Math.min(left, DELAY_SLICE_MS)
      await this.pause(slice)
      left -= slice
    }
    return !cancelled()
  }

  private async perform(step: Step, cancelled: () => boolean): Promise<void> {
    const session = this.session
    if (step instanceof ScriptRecorder.Tap) {
      const [x, y] = await this.awaitElement(step.target, cancelled)
      await session.tap(x, y)
    } else if (step instanceof ScriptRecorder.LongPress) {
      const [x, y] = await this.awaitElement(step.target, cancelled)
      await session.longPress(x, y, step.durationMs)
    } else if (step instanceof ScriptRecorder.DoubleTap) {
      const [x, y] = await this.awaitElement(step.target, cancelled)
      await session.doubleTap(x, y)
    } else if (step instanceof ScriptRecorder.Fill) {
      const [x, y] = await this.awaitElement(step.target, cancelled)
      await session.tap(x, y)
      await this.clearField(step.target, cancelled)
      await session.typeText(step.text)
    } else if (step instanceof ScriptRecorder.Expect) {
      await this.expect(step, cancelled)
    } else if (step instanceof ScriptRecorder.ExpectCount) {
      await this.expectCount(step, cancelled)
    } else if (step instanceof ScriptRecorder.WaitFor) {
      await this.waitFor(step, cancelled)
    } else if (step instanceof ScriptRecorder.Swipe) {
      await this.swipe(step.direction)
    } else if (step instanceof ScriptRecorder.ScrollUntilVisible) {
      await this.scrollUntilVisible(step, cancelled)
    } else if (step instanceof ScriptRecorder.Button) {
      if (step.name === 'HOME') await session.press('HOME')
      else throw new StepFailed(`Button ${step.name} is not supported`)
    } else if (step === ScriptRecorder.GoBack) {
      await session.press('BACK')
    }
  }

  /** Like Mobilewright's `expect`: retries until the assertion holds or the timeout passes. */
  private async expect(step: ScriptRecorder.Expect, cancelled: () => boolean): Promise<void> {
    const timeoutMs = ReplayOptions.resolveTimeoutMs(step.timeoutMs, this.elementTimeoutMs)
    const deadline = Date.now() + timeoutMs
    let problem = 'element not found'
    for (;;) {
      try {
        const node = step.target.resolve(await this.session.hierarchy())
        if (node === undefined) {
          if (step.assertion.passesWhenMissing) return
          problem = 'element not found'
        } else {
          if (step.assertion.holds(node)) return
          problem = `was ${step.assertion.actual(node)}`
        }
      } catch (e) {
        problem = `hierarchy: ${firstLine(e)}`
      }
      if (cancelled()) throw new StepFailed('Stopped')
      if (Date.now() >= deadline) {
        const label = step.assertion.label
        throw new StepFailed(`Expected ${step.target.code()} ${label.charAt(0).toLowerCase() + label.slice(1)}, ${problem} (after ${ReplayOptions.format(timeoutMs)})`)
      }
      await sleep(this.pollMs)
    }
  }

  /** Like `expect(locator).toHaveCount(n)`: counts every match of the locator, retrying until the number is right. */
  private async expectCount(step: ScriptRecorder.ExpectCount, cancelled: () => boolean): Promise<void> {
    const timeoutMs = ReplayOptions.resolveTimeoutMs(step.timeoutMs, this.elementTimeoutMs)
    const deadline = Date.now() + timeoutMs
    let problem = 'element not found'
    for (;;) {
      try {
        const count = step.target.countMatches(await this.session.hierarchy())
        if (count === step.count) return
        problem = `was ${count}`
      } catch (e) {
        problem = `hierarchy: ${firstLine(e)}`
      }
      if (cancelled()) throw new StepFailed('Stopped')
      if (Date.now() >= deadline) {
        throw new StepFailed(`Expected ${step.target.withoutNth().code()} to match ${step.count} elements, ${problem} (after ${ReplayOptions.format(timeoutMs)})`)
      }
      await sleep(this.pollMs)
    }
  }

  /** Like `locator.waitFor({ state })`: polls until the state holds; a missing element counts as hidden. */
  private async waitFor(step: ScriptRecorder.WaitFor, cancelled: () => boolean): Promise<void> {
    const timeoutMs = ReplayOptions.resolveTimeoutMs(step.timeoutMs, this.elementTimeoutMs)
    const deadline = Date.now() + timeoutMs
    let problem = 'element not found'
    for (;;) {
      try {
        const node = step.target.resolve(await this.session.hierarchy())
        if (step.state.holds(node)) return
        problem = node === undefined ? 'element not found' : `element is ${node.isVisible ? 'visible' : 'not visible'}`
      } catch (e) {
        problem = `hierarchy: ${firstLine(e)}`
      }
      if (cancelled()) throw new StepFailed('Stopped')
      if (Date.now() >= deadline) {
        throw new StepFailed(`Waiting for ${step.target.code()} to be ${step.state.js} timed out, ${problem} (after ${ReplayOptions.format(timeoutMs)})`)
      }
      await sleep(this.pollMs)
    }
  }

  /** Select all + backspace on the focused field, then read it back: like Mobilewright, a field that keeps its text fails the step. */
  private async clearField(target: ScriptRecorder.Target, cancelled: () => boolean): Promise<void> {
    try {
      await TextClearing.clearFocusedText(this.session)
    } catch (e) {
      if (e instanceof UnsupportedOperationOnDevice) throw new StepFailed(`Cannot clear the field before typing: ${e.message}`)
      throw e
    }
    for (let attempt = 0; attempt < CLEAR_CHECKS; attempt++) {
      const node = target.resolve(await this.session.hierarchy())
      if (node === undefined) return // the screen changed under us: nothing to check
      if (this.isEmptyField(node)) return
      if (cancelled()) throw new StepFailed('Stopped')
      if (attempt < CLEAR_CHECKS - 1) await sleep(this.pollMs)
    }
    throw new StepFailed(`Failed to clear element ${target.code()}: it still has text after select all + backspace`)
  }

  /**
   * Android uiautomator reports an empty field's hint in `text` (mobilecli's dump keeps it in `hint`), so text that
   * equals the hint counts as empty. A uiautomator without a `hint` attribute cannot be told apart: see TODO.md.
   */
  private isEmptyField(node: UiNode): boolean {
    const value = Assertion.inputValue(node) ?? ''
    return value.length === 0 || (node.platform === 'ANDROID' && value === node.attr('hint'))
  }

  /** The center of the visible element, polling the hierarchy until it appears. */
  private async awaitElement(target: ScriptRecorder.Target, cancelled: () => boolean): Promise<[number, number]> {
    const deadline = Date.now() + this.elementTimeoutMs
    let lastError: string | undefined
    for (;;) {
      try {
        const node = target.resolve(await this.session.hierarchy())
        const bounds = node?.bounds
        if (node !== undefined && node.isVisible && bounds !== undefined) return [rectCenterX(bounds), rectCenterY(bounds)]
      } catch (e) {
        lastError = firstLine(e)
      }
      if (cancelled()) throw new StepFailed('Stopped')
      if (Date.now() >= deadline) {
        throw new StepFailed(`${target.code()} not found within ${Math.trunc(this.elementTimeoutMs / 1000)} s` + (lastError !== undefined ? ` (hierarchy: ${lastError})` : ''))
      }
      await sleep(this.pollMs)
    }
  }

  /**
   * Swipes until the element is visible with its center on the screen, checking the hierarchy before the first
   * swipe and after every swipe, at most [ScriptRecorder.ScrollUntilVisible.maxSwipes] swipes.
   */
  private async scrollUntilVisible(step: ScriptRecorder.ScrollUntilVisible, cancelled: () => boolean): Promise<void> {
    let swipes = 0
    let problem = 'element not found'
    let readFailedSince = 0 // 0 while the hierarchy reads fine
    for (;;) {
      let readOk = true
      try {
        const size = this.session.logicalSize()
        if (size === undefined) throw new StepFailed('Screen size unknown')
        const node = step.target.resolve(await this.session.hierarchy())
        if (ScrollUntilVisible.isOnScreen(node, size)) return
        problem = node === undefined ? 'element not found' : 'element is not on the screen'
      } catch (e) {
        if (e instanceof StepFailed) throw e
        readOk = false
        problem = `hierarchy: ${firstLine(e)}`
      }
      if (cancelled()) throw new StepFailed('Stopped')
      if (!readOk) {
        // Never swipe blind: wait for the screen to be readable again, like the other element steps do.
        const now = Date.now()
        if (readFailedSince === 0) readFailedSince = now
        if (now - readFailedSince >= this.elementTimeoutMs) {
          throw new StepFailed(`${step.target.code()} did not become visible, ${problem} (after ${Math.trunc(this.elementTimeoutMs / 1000)} s)`)
        }
        await sleep(this.pollMs)
        continue
      }
      readFailedSince = 0
      if (swipes >= step.maxSwipes) {
        throw new StepFailed(`${step.target.code()} did not become visible after ${step.maxSwipes} swipes ${step.direction}, ${problem}`)
      }
      await this.swipe(step.direction)
      swipes++
      await sleep(this.pollMs) // let the scroll settle before reading the screen
    }
  }

  /** The finger moves in [direction] over the middle of the screen. */
  private async swipe(direction: string): Promise<void> {
    const size = this.session.logicalSize()
    if (size === undefined) throw new StepFailed('Screen size unknown')
    const w = size.width
    const h = size.height
    const t = Math.trunc
    switch (direction) {
      case 'up':
        return this.session.swipe(t(w / 2), t((h * 7) / 10), t(w / 2), t((h * 3) / 10))
      case 'down':
        return this.session.swipe(t(w / 2), t((h * 3) / 10), t(w / 2), t((h * 7) / 10))
      case 'left':
        return this.session.swipe(t((w * 8) / 10), t(h / 2), t((w * 2) / 10), t(h / 2))
      case 'right':
        return this.session.swipe(t((w * 2) / 10), t(h / 2), t((w * 8) / 10), t(h / 2))
      default:
        throw new StepFailed(`Unknown swipe direction ${direction}`)
    }
  }
}
