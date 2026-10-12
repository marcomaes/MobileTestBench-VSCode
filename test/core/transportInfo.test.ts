// ported-from: test:core/session/TransportInfoTest.kt
import { describe, expect, it } from 'vitest'
import { oneLine, transportTooltip } from '../../src/core/session/transportInfo'

describe('TransportInfoTest', () => {
  it('withoutFallback', () => expect(transportTooltip({ name: 'emulator gRPC' })).toBe('Transport: emulator gRPC'))

  it('withFallback', () => expect(transportTooltip({ name: 'adb screenshots', fallbackReason: 'gRPC failed' })).toBe('Transport: adb screenshots\nFallback: gRPC failed'))

  it('blankReasonIgnored', () => expect(transportTooltip({ name: 'x', fallbackReason: '  ' })).toBe('Transport: x'))

  it('reasonIsOneLineAndCut', () => {
    expect(oneLine('\n a \nb')).toBe('a')
    expect(oneLine('x'.repeat(500))).toHaveLength(300)
  })
})
