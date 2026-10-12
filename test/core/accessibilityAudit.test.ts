// ported-from: test:core/AccessibilityAuditTest.kt
import { describe, expect, it } from 'vitest'
import { AccessibilityAudit, AccessibilityIssue } from '../../src/core/inspector/accessibilityAudit'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect } from '../../src/core/model'
import { fixture } from '../helpers/fixtures'

const Rule = AccessibilityIssue.Rule

function android(attrs: Record<string, string>, ...children: UiNode[]): UiNode {
  const root = new UiNode('ANDROID', 'hierarchy', {}, undefined)
  const n = new UiNode('ANDROID', 'android.widget.ImageButton', attrs, rect(0, 0, 40, 40))
  children.forEach((c) => n.addChild(c))
  root.addChild(n)
  return root
}

function ios(type: string, attrs: Record<string, string>, w: number, h: number): UiNode {
  const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
  root.addChild(new UiNode('IOS', type, attrs, rect(0, 0, w, h)))
  return root
}

const iosNode = (type: string, w: number, h: number, label = 'x') => new UiNode('IOS', `XCUIElementType${type}`, { label, visible: 'true' }, rect(0, 0, w, h))
const placed = (type: string, x: number, y: number, w: number, h: number) => new UiNode('IOS', `XCUIElementType${type}`, { label: 'x', visible: 'true' }, rect(x, y, w, h))
const iosRoot = () => new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
const rules = (root: UiNode) => AccessibilityAudit.run(root).map((it) => it.rule)

describe('AccessibilityAuditTest', () => {
  it('clickable android element without text or description is flagged', () => {
    expect(rules(android({ clickable: 'true' }))).toEqual([Rule.MISSING_NAME])
  })

  it('android element is named by its own description or by a text child', () => {
    expect(AccessibilityAudit.run(android({ clickable: 'true', 'content-desc': 'Cart' }))).toEqual([])
    const child = new UiNode('ANDROID', 'android.widget.TextView', { text: 'Buy' }, rect(0, 0, 10, 10))
    expect(AccessibilityAudit.run(android({ clickable: 'true' }, child))).toEqual([])
  })

  it('non interactive android elements are ignored', () => {
    expect(AccessibilityAudit.run(android({ clickable: 'false' }))).toEqual([])
  })

  it('small ios touch targets are flagged, android sizes are not', () => {
    const small = AccessibilityAudit.run(ios('XCUIElementTypeButton', { label: 'Go', visible: 'true' }, 30, 44))
    expect(small.map((it) => it.rule)).toEqual([Rule.TARGET_BELOW_RECOMMENDED])
    expect(AccessibilityAudit.run(ios('XCUIElementTypeButton', { label: 'Go' }, 44, 44))).toEqual([])
    expect(AccessibilityAudit.run(android({ clickable: 'true', 'content-desc': 'x' }))).toEqual([])
  })

  it('elements inside a cell or another control are part of that target', () => {
    const root = iosRoot()
    const cell = iosNode('Cell', 350, 56)
    root.addChild(cell)
    cell.addChild(iosNode('Button', 307, 20, 'Record Video'))
    cell.addChild(iosNode('Button', 10, 14, 'chevron'))
    const button = iosNode('Button', 200, 44)
    root.addChild(button)
    button.addChild(iosNode('Button', 10, 10))
    expect(AccessibilityAudit.run(root)).toEqual([])
  })

  it('system switches sliders and text fields are not size checked', () => {
    const root = iosRoot()
    root.addChild(iosNode('Switch', 51, 31))
    root.addChild(iosNode('Slider', 200, 28))
    root.addChild(iosNode('TextField', 300, 34))
    expect(AccessibilityAudit.run(root)).toEqual([])
  })

  it('inline text links are not size checked', () => {
    const root = iosRoot()
    root.addChild(iosNode('Link', 330, 16, 'About Camera and ARKit & Privacy...'))
    expect(AccessibilityAudit.run(root)).toEqual([])
  })

  it('a 32 pt button meets the AA minimum but not the 44 pt recommendation', () => {
    const root = iosRoot()
    root.addChild(iosNode('Button', 32, 32))
    expect(rules(root)).toEqual([Rule.TARGET_BELOW_RECOMMENDED])
  })

  it('an undersized button far from other targets passes through the spacing exception', () => {
    const root = iosRoot()
    root.addChild(placed('Button', 0, 0, 20, 20))
    root.addChild(placed('Button', 200, 0, 100, 44))
    const r = rules(root)
    expect(r).not.toContain(Rule.TARGET_BELOW_MINIMUM)
    expect(r).toEqual([Rule.TARGET_BELOW_RECOMMENDED])
  })

  it('undersized buttons crowding each other fail the AA minimum', () => {
    const root = iosRoot()
    root.addChild(placed('Button', 0, 0, 20, 20))
    root.addChild(placed('Button', 20, 0, 20, 20))
    expect(rules(root)).toEqual([Rule.TARGET_BELOW_MINIMUM, Rule.TARGET_BELOW_MINIMUM])
  })

  it('an undersized button next to a large target fails the AA minimum', () => {
    const root = iosRoot()
    root.addChild(placed('Button', 0, 0, 20, 20))
    root.addChild(placed('Button', 20, 0, 100, 44))
    expect(rules(root)).toContain(Rule.TARGET_BELOW_MINIMUM)
  })

  it('hidden elements are not audited', () => {
    const hidden = ios('XCUIElementTypeButton', { visible: 'false' }, 10, 10)
    expect(AccessibilityAudit.run(hidden)).toEqual([])
  })

  it('the ios login fixture has no issues', () => {
    expect(AccessibilityAudit.run(WdaSourceParser.parse(fixture('ios_login.xml')))).toEqual([])
  })
})
