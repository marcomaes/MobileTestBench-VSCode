// ported-from: core/recording/ReplayOptions.kt
import { ScriptRecorder } from './scriptRecorder'

type Step = ScriptRecorder.Step

/** Kotlin `IntRange`: both ends are inclusive. */
export interface IntRange {
  readonly first: number
  readonly last: number
}

/** Kotlin `first..last`. */
export const intRange = (first: number, last: number): IntRange => ({ first, last })

const coerceIn = (value: number, range: IntRange): number => Math.min(Math.max(value, range.first), range.last)
const inRange = (value: number, range: IntRange): boolean => value >= range.first && value <= range.last

/** Replay settings (limits and clamping) and the choice of which steps a replay runs. Pure logic. */
export const ReplayOptions = {
  DEFAULT_TIMEOUT_SECONDS: 10,
  TIMEOUT_SECONDS: intRange(1, 300),
  DEFAULT_DELAY_MS: 0,
  DELAY_MS: intRange(0, 10_000),

  /** The per-step timeout of a wait or expect, in seconds. */
  STEP_TIMEOUT_SECONDS: intRange(1, 3600),

  timeoutMs(seconds: number): number {
    return coerceIn(seconds, ReplayOptions.TIMEOUT_SECONDS) * 1000
  },

  delayMs(ms: number): number {
    return coerceIn(ms, ReplayOptions.DELAY_MS)
  },

  /** The timeout a step runs with: its own when it has one, otherwise the replay default. */
  resolveTimeoutMs(stepTimeoutMs: number | undefined | null, defaultMs: number): number {
    return stepTimeoutMs !== undefined && stepTimeoutMs !== null && stepTimeoutMs > 0 ? stepTimeoutMs : defaultMs
  },

  /** Whole seconds typed by the user for a step timeout; undefined when it is not a number in [STEP_TIMEOUT_SECONDS]. */
  parseStepSeconds(text: string): number | undefined {
    const t = text.trim()
    if (!/^[+-]?\d+$/.test(t)) return undefined
    const n = Number(t)
    return inRange(n, ReplayOptions.STEP_TIMEOUT_SECONDS) ? n : undefined
  },

  /** The seconds of a timeout in milliseconds, rounded up, for code that takes whole seconds. */
  wholeSeconds(ms: number): number {
    return Math.max(Math.trunc((ms + 999) / 1000), 1)
  },

  /** For messages: "10 s", "0.5 s". */
  format(ms: number): string {
    if (ms % 1000 === 0) return `${Math.trunc(ms / 1000)} s`
    return `${javaDouble(Math.trunc(ms / 100) / 10)} s`
  },

  /** The selected step and everything after it; undefined when nothing valid is selected. */
  fromSelected(selected: Iterable<number>, size: number): IntRange | undefined {
    const valid = [...selected].filter((it) => it >= 0 && it < size)
    if (valid.length === 0) return undefined
    return intRange(Math.min(...valid), size - 1)
  },

  /** From the first to the last selected step (a selection with gaps replays the gaps too); undefined when nothing valid is selected. */
  selectedRange(selected: Iterable<number>, size: number): IntRange | undefined {
    const valid = [...selected].filter((it) => it >= 0 && it < size)
    if (valid.length === 0) return undefined
    return intRange(Math.min(...valid), Math.max(...valid))
  },

  /** Waits and expects (not scroll until visible, whose limit is its swipe count) can carry their own timeout. */
  supportsTimeout(step: Step): boolean {
    return step instanceof ScriptRecorder.WaitFor || step instanceof ScriptRecorder.Expect || step instanceof ScriptRecorder.ExpectCount
  },

  timeoutOf(step: Step): number | undefined {
    if (step instanceof ScriptRecorder.WaitFor || step instanceof ScriptRecorder.Expect || step instanceof ScriptRecorder.ExpectCount) return step.timeoutMs
    return undefined
  },

  /** The step with [timeoutMs] (undefined removes it); a step that cannot carry one is returned as it is. */
  withTimeout(step: Step, timeoutMs: number | undefined): Step {
    if (step instanceof ScriptRecorder.WaitFor || step instanceof ScriptRecorder.Expect || step instanceof ScriptRecorder.ExpectCount) return step.copy({ timeoutMs })
    return step
  },

  /**
   * Mobilewright: adds `{ timeout: ms }` as the last argument of a matcher call (`.toBeVisible()` becomes
   * `.toBeVisible({ timeout: 5000 })`, `.toHaveText('x')` becomes `.toHaveText('x', { timeout: 5000 })`).
   */
  matcherWithTimeout(matcher: string, timeoutMs: number | undefined | null): string {
    if (timeoutMs === undefined || timeoutMs === null) return matcher
    if (matcher.endsWith('()')) return matcher.slice(0, -1) + `{ timeout: ${timeoutMs} })`
    return matcher.slice(0, -1) + `, { timeout: ${timeoutMs} })`
  },
}

/** Kotlin `Double.toString()` for the values `ms / 100 / 10.0` can take: a whole number gets ".0". */
function javaDouble(d: number): string {
  return Number.isInteger(d) ? `${d}.0` : String(d)
}
