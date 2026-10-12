// ported-from: test:core/GesturesTest.kt
// The 'recorder' region of GesturesTest, split out because it needs ScriptRecorder (the rest is in gestures.test.ts).
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { fixture } from '../helpers/fixtures'

const ios = WdaSourceParser.parse(fixture('ios_login.xml'))

describe('GesturesTest recorder', () => {
  it('long press and double tap are recorded on the same locator a tap would use', () => {
    const r = new ScriptRecorder('IOS')
    r.longPress(ios, 100, 220, 700)
    r.doubleTap(ios, 100, 320)
    expect(r.steps[0].code()).toBe("await screen.getByTestId('email-input').longPress({ duration: 700 });")
    expect(r.steps[0].code().endsWith('.longPress({ duration: 700 });')).toBe(true)
    expect(r.steps[1].code().endsWith('.doubleTap();')).toBe(true)
  })

  it('the tap sent before a double click is folded into the double tap', () => {
    const r = new ScriptRecorder('IOS')
    r.tap(ios, 100, 220)
    r.doubleTap(ios, 100, 220)
    expect(r.steps.length).toBe(1)
    expect(r.code()).toBe("await screen.getByTestId('email-input').doubleTap();")
    r.tap(ios, 100, 320)
    r.doubleTap(ios, 100, 220)
    expect(r.steps.length).toBe(3)
  })

  it('a gesture where nothing is found or the hierarchy is missing is a comment', () => {
    const r = new ScriptRecorder('IOS')
    r.longPress(ios, 9999, 9999, 700)
    r.tapWithoutHierarchy(5, 6, 'no agent', 'double tap')
    r.dragWithHold(1, 2, 3, 4, 700)
    expect(r.steps[0].code()).toBe('// long press at (9999, 9999): no element found there')
    expect(r.steps[1].code()).toBe('// double tap at (5, 6): hierarchy unavailable (no agent)')
    expect(r.steps[2].code().startsWith('// drag with hold (700 ms) from (1, 2) to (3, 4)')).toBe(true)
  })
})
