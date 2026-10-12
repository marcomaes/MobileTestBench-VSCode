// ported-from: core/recording/ScreenRecordingLimit.kt

/** The optional time limit of a screen recording: a setting in seconds, 0 meaning no limit. */
export const ScreenRecordingLimit = {
  MAX_SECONDS: 3600,
  SECONDS: { min: 0, max: 3600 },

  /** The stored setting clamped to [SECONDS]. */
  clamp(setting: number): number {
    return Math.min(3600, Math.max(0, Math.trunc(setting)))
  },

  /** Milliseconds after which to stop automatically, or undefined for no limit. */
  limitMs(setting: number): number | undefined {
    const s = ScreenRecordingLimit.clamp(setting)
    return s > 0 ? s * 1000 : undefined
  },
}
