// ported-from: core/recording/ScrollUntilVisible.kt
import { rectCenterX, rectCenterY, type Size } from '../model'
import type { UiNode } from '../inspector/uiNode'
import { WaitState } from './assertion'
import type { IntRange } from './replayOptions'
import { ScriptRecorder } from './scriptRecorder'

type Step = ScriptRecorder.Step

class Converted {
  constructor(readonly steps: readonly Step[]) {}
}

class Rejected {
  constructor(readonly reason: string) {}
}

/** Turns recorded swipes plus the element step after them into one bounded "scroll until visible" step. */
export const ScrollUntilVisible = {
  DEFAULT_MAX_SWIPES: 10,
  DIRECTIONS: ['up', 'down', 'left', 'right'] as readonly string[],
  LIMIT_RANGE: { first: 1, last: 100 } as IntRange,

  Result: { Converted, Rejected },

  /** A whole number of swipes within [LIMIT_RANGE], or undefined. */
  parseLimit(text: string): number | undefined {
    const t = text.trim()
    if (!/^[+-]?\d+$/.test(t)) return undefined
    const n = Number(t)
    return n >= ScrollUntilVisible.LIMIT_RANGE.first && n <= ScrollUntilVisible.LIMIT_RANGE.last ? n : undefined
  },

  /** The step with another direction and swipe limit, or undefined when either is not allowed. */
  withOptions(step: ScriptRecorder.ScrollUntilVisible, direction: string, maxSwipes: number): ScriptRecorder.ScrollUntilVisible | undefined {
    const r = ScrollUntilVisible.LIMIT_RANGE
    return ScrollUntilVisible.DIRECTIONS.includes(direction) && maxSwipes >= r.first && maxSwipes <= r.last ? step.copy({ direction, maxSwipes }) : undefined
  },

  /**
   * The target of a step that acts on one element, or undefined for steps a scroll cannot lead up to. That includes
   * steps that expect the element to be hidden or missing: scrolling until it is visible would contradict them.
   */
  targetOf(step: Step): ScriptRecorder.Target | undefined {
    if (step instanceof ScriptRecorder.Tap || step instanceof ScriptRecorder.LongPress || step instanceof ScriptRecorder.DoubleTap || step instanceof ScriptRecorder.Fill) return step.target
    if (step instanceof ScriptRecorder.Expect) return step.assertion.passesWhenMissing ? undefined : step.target
    if (step instanceof ScriptRecorder.WaitFor) return step.state === WaitState.HIDDEN ? undefined : step.target
    return undefined
  },

  /**
   * Replaces the swipes at [indices] by a [ScriptRecorder.ScrollUntilVisible] placed before the step that follows
   * them. The swipes must be next to each other, all in the same direction, and followed by an element step.
   * The limit is [DEFAULT_MAX_SWIPES], or the number of swipes selected when that is more.
   */
  convert(steps: readonly Step[], indices: Iterable<number>): Converted | Rejected {
    const sorted = [...new Set(indices)].sort((a, b) => a - b)
    if (sorted.length === 0) return new Rejected('Select the swipe steps first')
    if (sorted.some((it) => it < 0 || it >= steps.length)) return new Rejected('The selection is out of date')
    const swipes: ScriptRecorder.Swipe[] = []
    for (const i of sorted) {
      const step = steps[i]
      if (!(step instanceof ScriptRecorder.Swipe)) return new Rejected('Only swipe steps can be turned into a scroll')
      swipes.push(step)
    }
    if (sorted[sorted.length - 1] - sorted[0] !== sorted.length - 1) return new Rejected('The selected swipes must be next to each other')
    const direction = swipes[0].direction
    if (swipes.some((it) => it.direction !== direction)) return new Rejected('The selected swipes go in different directions')
    const next = steps[sorted[sorted.length - 1] + 1]
    if (next === undefined) return new Rejected('There is no step after the swipes to scroll to')
    const target = ScrollUntilVisible.targetOf(next)
    if (target === undefined) return new Rejected('The step after the swipes does not act on an element')
    const scroll = new ScriptRecorder.ScrollUntilVisible(target, direction, Math.max(ScrollUntilVisible.DEFAULT_MAX_SWIPES, swipes.length))
    return new Converted([...steps.slice(0, sorted[0]), scroll, ...steps.slice(sorted[sorted.length - 1] + 1)])
  },

  /** Visible, and its center is on the screen, so that a tap there hits it. A missing element is not on screen. */
  isOnScreen(node: UiNode | undefined, screen: Size): boolean {
    const bounds = node?.bounds
    if (node === undefined || bounds === undefined) return false
    const cx = rectCenterX(bounds)
    const cy = rectCenterY(bounds)
    return node.isVisible && cx >= 0 && cx < screen.width && cy >= 0 && cy < screen.height
  },
}
