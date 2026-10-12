// ported-from: test:core/ScriptRecorderTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect } from '../../src/core/model'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

const recorder = () => new ScriptRecorder('IOS')

describe('ScriptRecorderTest', () => {
  it('a tap becomes a tap on the best unique locator', () => {
    const r = recorder()
    r.tap(ios, 100, 220) // email text field at 20,200 350x44
    expect(r.code()).toBe("await screen.getByTestId('email-input').tap();")
  })

  it('typing after a tap turns it into fill and backspace edits it', () => {
    const r = recorder()
    r.tap(ios, 100, 220)
    r.type('a')
    r.type('b')
    r.type('c')
    expect(r.code()).toBe("await screen.getByTestId('email-input').fill('abc');")
    r.delete()
    expect(r.code()).toBe("await screen.getByTestId('email-input').fill('ab');")
    r.delete()
    r.delete()
    expect(r.code()).toBe("await screen.getByTestId('email-input').tap();")
  })

  it('typing without a tap is kept as a comment', () => {
    const r = recorder()
    r.type('hi')
    expect(r.code().startsWith("// typed 'hi'")).toBe(true)
  })

  it('swipes use the finger direction', () => {
    const r = recorder()
    r.swipe(100, 600, 100, 200)
    r.swipe(100, 200, 100, 600)
    r.swipe(300, 300, 50, 300)
    expect(r.code()).toBe("await screen.swipe('up');\nawait screen.swipe('down');\nawait screen.swipe('left');")
  })

  it('home and back buttons', () => {
    const i = recorder()
    i.key('HOME')
    i.key('BACK')
    expect(i.code()).toBe("await screen.pressButton('HOME');\n// pressed BACK")
    const android = new ScriptRecorder('ANDROID')
    android.key('BACK')
    expect(android.code()).toBe('await screen.goBack();')
  })

  it('a tap with no element or no locator is a comment, never raw coordinates', () => {
    const r = recorder()
    r.tap(ios, 5000, 5000)
    r.tapWithoutHierarchy(1, 2, 'timeout')
    expect(r.steps.every((it) => it instanceof ScriptRecorder.Note)).toBe(true)
    expect(r.code().split(/\r?\n/).every((it) => it.startsWith('//'))).toBe(true)
  })

  it('duplicate locators get an index', () => {
    const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    for (let i = 0; i < 3; i++) {
      root.addChild(new UiNode('IOS', 'XCUIElementTypeButton', { name: 'Add', label: 'Add', visible: 'true' }, rect(0, i * 100, 80, 40)))
    }
    const r = recorder()
    r.tap(root, 10, 215) // third button
    expect(r.code()).toBe("await screen.getByRole('button', { name: 'Add' }).nth(2).tap();")
  })

  it('a text inside a button resolves to the buttons test id', () => {
    const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    const button = new UiNode('IOS', 'XCUIElementTypeButton', { name: 'submit-btn', label: 'Submit', visible: 'true' }, rect(0, 0, 200, 50))
    root.addChild(button)
    button.addChild(new UiNode('IOS', 'XCUIElementTypeStaticText', { name: 'Submit', label: 'Submit', visible: 'true' }, rect(60, 10, 80, 30)))
    const r = recorder()
    r.tap(root, 100, 25)
    expect(r.code()).toBe("await screen.getByTestId('submit-btn').tap();")
  })

  it('a tap matched against an older screen is flagged', () => {
    const r = recorder()
    r.tap(ios, 100, 220, false)
    expect(r.code().startsWith("await screen.getByTestId('email-input').tap();  // check")).toBe(true)
    r.type('a')
    expect(r.code().includes(".fill('a');  // check")).toBe(true)
  })
})
