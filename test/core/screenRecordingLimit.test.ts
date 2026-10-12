// ported-from: test:core/ScreenRecordingLimitTest.kt
import { describe, expect, it } from 'vitest'
import { ScreenRecordingLimit } from '../../src/core/recording/screenRecordingLimit'

describe('ScreenRecordingLimitTest', () => {
  it('zeroAndNegativeMeanNoLimit', () => {
    expect(ScreenRecordingLimit.limitMs(0)).toBeUndefined()
    expect(ScreenRecordingLimit.limitMs(-5)).toBeUndefined()
  })

  it('convertsSecondsToMillis', () => {
    expect(ScreenRecordingLimit.limitMs(30)).toBe(30_000)
  })

  it('clampsToMaximum', () => {
    expect(ScreenRecordingLimit.clamp(99999)).toBe(3600)
    expect(ScreenRecordingLimit.limitMs(99999)).toBe(3_600_000)
  })
})
