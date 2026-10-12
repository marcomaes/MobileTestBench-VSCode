// ported-from: test:core/InspectorTest.kt
import { describe, expect, it } from 'vitest'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { LocatorGenerator, MobilewrightLocators } from '../../src/core/inspector/locators'
import { HierarchyQueries, UiNode } from '../../src/core/inspector/uiNode'
import { rect, type Platform } from '../../src/core/model'
import { fixture } from '../helpers/fixtures'

const android = (): UiNode => UiAutomatorParser.parse(fixture('android_login.xml'))
const ios = (): UiNode => WdaSourceParser.parse(fixture('ios_login.xml'))

describe('InspectorTest', () => {
  it('role names follow the mobilewright role map', () => {
    const role = (platform: Platform, rawType: string) => MobilewrightLocators.role(new UiNode(platform, rawType, {}, undefined))
    expect(role('IOS', 'XCUIElementTypeStaticText')).toBe('text')
    expect(role('IOS', 'XCUIElementTypeCell')).toBe('listitem')
    expect(role('IOS', 'XCUIElementTypeOther')).toBe('listitem')
    expect(role('ANDROID', 'com.google.android.material.button.MaterialButton')).toBe('button')
    expect(role('ANDROID', 'androidx.appcompat.widget.AppCompatEditText')).toBe('textfield')
    expect(role('ANDROID', 'android.widget.RadioButton')).toBe('radio')
    expect(role('ANDROID', 'android.widget.ToggleButton')).toBe('switch')
    expect(role('ANDROID', 'android.view.View')).toBeUndefined()
  })

  it('parses uiautomator hierarchy', () => {
    const root = android()
    const nodes = [...root.walk()]
    expect(nodes.length).toBe(7)
    const email = nodes.find((it) => it.resourceId === 'com.example.app:id/email')!
    expect(email.type).toBe('EditText')
    expect(email.label).toBe('Email')
    expect(email.bounds).toEqual(rect(40, 400, 1000, 120))
    expect(email.absoluteXPath()).toBe('/hierarchy/android.widget.FrameLayout[1]/android.widget.LinearLayout[1]/android.widget.EditText[1]')
    const secondButton = nodes.filter((it) => it.type === 'Button')[1]
    expect(secondButton.xpathIndex()).toBe(2)
  })

  it('parses wda source', () => {
    const root = ios()
    expect(root.type).toBe('Application')
    const field = [...root.walk()].find((it) => it.type === 'TextField')!
    expect(field.identifier).toBe('email-input')
    expect(field.label).toBe('Email')
    const button = [...root.walk()].find((it) => it.type === 'Button')!
    // name equals label, so it is not treated as an accessibility identifier
    expect(button.identifier).toBeUndefined()
  })

  it('deepest node at point skips invisible nodes', () => {
    const root = ios()
    const hit = HierarchyQueries.deepestAt(root, 25, 305)
    expect(hit?.label).toBe('Sign In')
    const androidHit = HierarchyQueries.deepestAt(android(), 500, 450)
    expect(androidHit?.resourceId).toBe('com.example.app:id/email')
  })

  it('mobilewright priority matches the inspector', () => {
    const root = android()
    const email = [...root.walk()].find((it) => it.resourceId !== undefined && it.resourceId.endsWith('email'))!
    const best = MobilewrightLocators.derive(email)!
    expect(best.kind).toBe(MobilewrightLocators.Kind.TEST_ID)
    expect(MobilewrightLocators.toCode(best)).toBe("screen.getByTestId('com.example.app:id/email')")

    const welcome = [...root.walk()].find((it) => it.text === 'Welcome')!
    expect(MobilewrightLocators.toCode(MobilewrightLocators.derive(welcome)!)).toBe("screen.getByRole('text', { name: 'Welcome' })")

    const iosField = [...ios().walk()].find((it) => it.type === 'TextField')!
    expect(MobilewrightLocators.toCode(MobilewrightLocators.derive(iosField)!)).toBe("screen.getByTestId('email-input')")
  })

  it('duplicate locators are detected', () => {
    const root = android()
    const button = [...root.walk()].find((it) => it.type === 'Button')!
    const suggestions = LocatorGenerator.suggest(button, root)
    const best = suggestions.find((it) => it.isBest)!
    expect(best.expression).toBe("screen.getByRole('button', { name: 'Sign In' })")
    expect(best.matchCount).toBe(2)
    expect(best.isUnique).toBe(false)
    const absolute = suggestions.find((it) => it.strategy === 'xpath (absolute)')!
    expect(absolute.isUnique).toBe(true)
  })

  it('ios appium locators', () => {
    const root = ios()
    const field = [...root.walk()].find((it) => it.type === 'TextField')!
    const suggestions = LocatorGenerator.suggest(field, root)
    const predicate = suggestions.find((it) => it.strategy === '-ios predicate string')!
    expect(predicate.expression).toBe("type == 'XCUIElementTypeTextField' AND name == 'email-input'")
    expect(predicate.isUnique).toBe(true)
    const chain = suggestions.find((it) => it.strategy === '-ios class chain')!
    expect(chain.expression).toBe("**/XCUIElementTypeTextField[`name == 'email-input'`]")
    expect(suggestions.find((it) => it.strategy === 'accessibility id')).toBeDefined()
  })

  it('xpath literal handles quotes', () => {
    expect(LocatorGenerator.xpathLiteral('a')).toBe('"a"')
    expect(LocatorGenerator.xpathLiteral('say "hi"')).toBe("'say \"hi\"'")
    expect(LocatorGenerator.xpathLiteral('it\'s "x"')).toBe('concat("it\'s ", \'"\', "x", \'"\', "")')
  })
})
