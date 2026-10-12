// ported-from: core/input/Gestures.kt

/** How the mirror turns mouse events into device gestures. Pure, so the rules are unit tested. */
export const Gestures = {
  /**
   * How long the mouse stays down before it counts as a long press, and the hold the device gets. Android's own long
   * press timeout is about 400 ms and iOS's 500 ms; anything shorter than 700 ms was flaky on the emulator.
   */
  LONG_PRESS_MS: 700,

  /** Allowed range of the long press setting (ms). */
  LONG_PRESS_RANGE: { min: 300, max: 3000 },

  /** The long press time to use for a stored setting value: clamped to [LONG_PRESS_RANGE]. */
  longPressMs: (setting: number): number => Math.min(Math.max(setting, Gestures.LONG_PRESS_RANGE.min), Gestures.LONG_PRESS_RANGE.max),

  /** The initial hold of an Option/Alt drag. */
  HOLD_DRAG_MS: 700,

  movedBeyondSlop: (dx: number, dy: number, slop: number): boolean => Math.hypot(dx, dy) >= slop,

  /**
   * What a mouse release means. [clickCount] is the count of quick clicks: the second click is a double tap, the third a
   * plain tap again. [alt] is Option/Alt held when the button went down.
   */
  onRelease(longPressFired: boolean, moved: boolean, alt: boolean, clickCount: number): GestureRelease {
    if (longPressFired) return 'CONSUMED'
    if (moved) return alt ? 'HOLD_DRAG' : 'SWIPE'
    if (clickCount >= 2 && clickCount % 2 === 0) return 'DOUBLE_TAP'
    return 'TAP'
  },
}

/** CONSUMED: a long press already went out while the button was down, the release does nothing. */
export type GestureRelease = 'CONSUMED' | 'TAP' | 'DOUBLE_TAP' | 'SWIPE' | 'HOLD_DRAG'
