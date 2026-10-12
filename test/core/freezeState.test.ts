// ported-from: test:core/FreezeStateTest.kt
import { describe, expect, it } from 'vitest'
import { FreezeState } from '../../src/core/freeze/freezeState'

describe('FreezeStateTest', () => {
  it('startsUnfrozen', () => {
    const s = new FreezeState()
    expect(s.frozen).toBe(false)
    expect(s.isCurrent(0)).toBe(false)
  })

  it('freezeTokenIsCurrentUntilUnfrozen', () => {
    const s = new FreezeState()
    const token = s.freeze()
    expect(s.frozen).toBe(true)
    expect(s.isCurrent(token)).toBe(true)
    s.unfreeze()
    expect(s.frozen).toBe(false)
    expect(s.isCurrent(token)).toBe(false)
  })

  it('freezingTwiceKeepsTheToken', () => {
    const s = new FreezeState()
    expect(s.freeze()).toBe(s.freeze())
  })

  it('oldTokenIsNotCurrentAfterRefreeze', () => {
    const s = new FreezeState()
    const first = s.freeze()
    s.unfreeze()
    const second = s.freeze()
    expect(s.isCurrent(first)).toBe(false)
    expect(s.isCurrent(second)).toBe(true)
  })
})
