// ported-from: test:core/AccessibilityAndroidTest.kt
import { describe, expect, it } from 'vitest'
import type { PixelImage } from '../../src/core/image/pixels'
import { AccessibilityAudit, AccessibilityIssue, ContrastStatus } from '../../src/core/inspector/accessibilityAudit'
import { MobilecliAndroidRawParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect, size, type Rect } from '../../src/core/model'
import { fixture } from '../helpers/fixtures'
import { fillRect, newImage } from '../helpers/drawing'

const Rule = AccessibilityIssue.Rule
const dpi = 420
const screen = size(1080, 2424)

const root = () => new UiNode('ANDROID', 'hierarchy', {}, undefined)

function node(cls: string, x: number, y: number, w: number, h: number, attrs: Record<string, string>, parent: UiNode): UiNode {
  const n = new UiNode('ANDROID', cls, { visible: 'true', enabled: 'true', ...attrs }, rect(x, y, w, h))
  parent.addChild(n)
  return n
}

const button = (parent: UiNode, x: number, y: number, w: number, h: number, cls = 'android.widget.Button') => node(cls, x, y, w, h, { clickable: 'true', text: 'Go' }, parent)

// null is Kotlin's explicit null density (undefined would take the default).
const rules = (r: UiNode, density: number | null = dpi) => AccessibilityAudit.run(r, density ?? undefined, undefined, screen, false).map((it) => it.rule)

describe('AccessibilityAndroidTest', () => {
  it('a 40 dp button on 420 dpi is below the Material recommendation but not below the minimum', () => {
    const r = root()
    button(r, 100, 500, 105, 105)
    const issues = AccessibilityAudit.run(r, dpi, undefined, screen, false)
    expect(issues.map((it) => it.rule)).toEqual([Rule.TARGET_BELOW_RECOMMENDED])
    expect(issues[0].message.includes('40 x 40 dp (105 x 105 px at 420 dpi)') && issues[0].message.includes('48'), issues[0].message).toBe(true)
  })

  it('a 48 dp button passes and 56 dp too', () => {
    const r = root()
    button(r, 100, 500, 126, 126)
    button(r, 100, 900, 996, 147)
    expect(rules(r)).toEqual([])
  })

  it('without density the android size rules are skipped', () => {
    const r = root()
    button(r, 100, 500, 20, 20)
    expect(rules(r, null)).toEqual([])
  })

  it('a 20 dp button crowded by another target fails the AA minimum, in dp not pixels', () => {
    const r = root()
    button(r, 100, 500, 53, 53) // 20 dp, centre x 126.5
    button(r, 140, 500, 126, 126) // 13.5 px = 5 dp from the centre, inside the 12 dp radius
    expect(rules(r)[0]).toBe(Rule.TARGET_BELOW_MINIMUM)
  })

  it('the 24 dp spacing exception works on android', () => {
    const r = root()
    button(r, 100, 500, 53, 53) // 20 dp, centre at 126 px
    // the other target is 80 dp (210 px) away from the circle edge: 24 px would be wrong, 63 px (24 dp) is the radius
    button(r, 100 + 53 + 90, 500, 126, 126) // 90 px = 34 dp gap, more than the 12 dp radius
    const result = rules(r)
    expect(result).not.toContain(Rule.TARGET_BELOW_MINIMUM)
    expect(result.slice(0, 1)).toEqual([Rule.TARGET_BELOW_RECOMMENDED])
  })

  it('a neighbour 20 px away is inside the 12 dp circle radius', () => {
    const r = root()
    button(r, 100, 500, 20, 53) // centre x 110
    button(r, 130, 500, 126, 126) // 20 px = 7.6 dp from the centre: inside 12 dp, outside a 12 px circle
    expect(rules(r)[0]).toBe(Rule.TARGET_BELOW_MINIMUM)
  })

  it('children of a clickable container are part of that target', () => {
    const r = root()
    const row = node('android.widget.LinearLayout', 0, 500, 1080, 147, { clickable: 'true' }, r)
    node('android.widget.CheckedTextView', 0, 500, 40, 40, { checkable: 'true', text: 'x' }, row)
    node('android.widget.ImageButton', 0, 500, 30, 30, { clickable: 'true', 'content-desc': 'i' }, row)
    expect(rules(r)).toEqual([])
  })

  it('switches checkboxes and spinners are exempt from the 48 dp rule but not the 24 dp rule', () => {
    const r = root()
    node('android.widget.Switch', 100, 500, 122, 71, { clickable: 'true', checkable: 'true', text: 't' }, r) // 46 x 27 dp
    node('android.widget.CheckBox', 100, 900, 105, 105, { clickable: 'true', checkable: 'true', text: 't' }, r)
    expect(rules(r)).toEqual([])
    node('android.widget.CheckBox', 100, 1300, 40, 40, { clickable: 'true', checkable: 'true', text: 't' }, r) // 15 dp, alone
    expect(rules(r), 'alone, so the spacing exception applies').toEqual([])
    // the 24 dp rule still applies to small-drawn controls once another target crowds them
    const crowded = root()
    node('android.widget.CheckBox', 100, 500, 40, 40, { clickable: 'true', checkable: 'true', text: 't' }, crowded)
    button(crowded, 145, 500, 126, 126)
    expect(rules(crowded)).toEqual([Rule.TARGET_BELOW_MINIMUM])
    // a short spinner is exempt from the 48 dp rule, but crowded it fails the 24 dp rule
    const spin = root()
    node('android.widget.Spinner', 100, 500, 300, 40, { clickable: 'true', text: 's' }, spin) // 114 x 15 dp
    expect(rules(spin), 'alone').toEqual([])
    button(spin, 190, 545, 126, 126)
    expect(rules(spin)).toEqual([Rule.TARGET_BELOW_MINIMUM])
  })

  it('clickable text views disabled controls and system ui are not size checked', () => {
    const r = root()
    node('android.widget.TextView', 100, 500, 300, 40, { clickable: 'true', text: 'link' }, r)
    node('android.widget.Button', 100, 900, 50, 50, { clickable: 'true', enabled: 'false', text: 'x' }, r)
    node('android.widget.ImageButton', 100, 1300, 50, 50, { clickable: 'true', 'resource-id': 'com.android.systemui:id/back', 'content-desc': 'Back' }, r)
    expect(rules(r)).toEqual([])
  })

  it('controls cut by the bottom screen edge are not judged', () => {
    const r = root()
    button(r, 0, 2418, 400, 6)
    expect(rules(r)).toEqual([])
    // the same size in the middle of the screen is judged
    const r2 = root()
    button(r2, 0, 1000, 400, 6)
    expect(rules(r2).length).toBeGreaterThan(0)
  })

  it('the real controls dump gives the expected size findings', () => {
    const rootNode = MobilecliAndroidRawParser.parse(fixture('mobilecli_android_controls_dump.json'))
    const issues = AccessibilityAudit.run(rootNode, dpi, undefined, screen, false)
    const sizes = issues.filter((it) => it.rule !== Rule.MISSING_NAME)
    // The stepper buttons are 40 x 40 dp.
    expect(sizes.some((it) => it.rule === Rule.TARGET_BELOW_RECOMMENDED && it.message.includes('40 x 40 dp'))).toBe(true)
    // Nothing the Playground draws is below 24 dp except possibly crowded; the 56 dp rows and the switch are fine.
    expect(sizes.every((it) => !(it.node.type === 'Switch' || it.node.type === 'CheckedTextView' || it.node.type === 'Spinner'))).toBe(true)
    expect(sizes.every((it) => !(it.node.bounds!.width > 900))).toBe(true)
  })

  // region contrast

  function frame(textColor: number, bg: number, w = 1080, h = 2424, area: Rect = rect(40, 1000, 400, 60)): PixelImage {
    const img = newImage(w, h, bg)
    let x = area.x + 6
    while (x < area.x + area.width - 10) {
      fillRect(img, textColor, x, area.y + 20, 5, 20)
      x += 24
    }
    return img
  }

  function textRoot(enabled = 'true'): UiNode {
    const r = root()
    node('android.widget.TextView', 40, 1000, 400, 60, { text: 'Hello', enabled }, r)
    return r
  }

  it('low contrast text gets a hint with ratio and both colors', () => {
    const result = AccessibilityAudit.analyse(textRoot(), dpi, () => frame(0x9e9e9e, 0xffffff), screen)
    expect(result.issues.length).toBe(1)
    const issue = result.issues[0]
    expect(issue.rule).toBe(Rule.LOW_CONTRAST_HINT)
    expect(result.contrast).toBe(ContrastStatus.ON)
    expect(issue.message.includes('2.68:1') && issue.message.includes('#9E9E9E') && issue.message.includes('#FFFFFF') && issue.message.includes('hint'), issue.message).toBe(true)
    expect(issue.contrast).toBeDefined()
  })

  it('good contrast and the borderline 4_61 text are not reported', () => {
    expect(AccessibilityAudit.run(textRoot(), dpi, () => frame(0x202020, 0xffffff), screen)).toEqual([])
    expect(AccessibilityAudit.run(textRoot(), dpi, () => frame(0x757575, 0xffffff), screen)).toEqual([])
  })

  it('disabled text and elements without text are exempt', () => {
    expect(AccessibilityAudit.run(textRoot('false'), dpi, () => frame(0x9e9e9e, 0xffffff), screen)).toEqual([])
    const r = root()
    node('android.widget.ImageView', 40, 1000, 400, 60, { 'content-desc': 'Navigate up' }, r)
    expect(AccessibilityAudit.run(r, dpi, () => frame(0x9e9e9e, 0xffffff), screen)).toEqual([])
  })

  it('contrast needs a frame, can be switched off and reports its status', () => {
    const none = AccessibilityAudit.analyse(textRoot(), dpi, () => undefined, screen)
    expect(none.contrast).toBe(ContrastStatus.NO_FRAME)
    expect(none.statusLine).toBe('Density 420 dpi (2.63x) - no frame: contrast skipped')
    expect(AccessibilityAudit.analyse(textRoot(), dpi, undefined, screen).contrast).toBe(ContrastStatus.NO_FRAME)
    const off = AccessibilityAudit.analyse(textRoot(), undefined, () => frame(0x9e9e9e, 0xffffff), screen, false)
    expect(off.contrast).toBe(ContrastStatus.OFF)
    expect(off.issues).toEqual([])
    expect(off.statusLine).toBe('Density unknown: Android size rules skipped - contrast hints off')
  })

  it('ios text is sampled in points on a retina frame', () => {
    const r = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    r.addChild(new UiNode('IOS', 'XCUIElementTypeStaticText', { label: 'Hello', visible: 'true' }, rect(10, 100, 200, 30)))
    const img = frame(0xaaaaaa, 0xffffff, 1206, 2622, rect(30, 300, 600, 90))
    const result = AccessibilityAudit.analyse(r, undefined, () => img, size(402, 874))
    expect(result.issues.map((it) => it.rule)).toEqual([Rule.LOW_CONTRAST_HINT])
    expect(result.statusLine.startsWith('Sizes in points')).toBe(true)
  })

  // endregion
})
