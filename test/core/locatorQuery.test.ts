// ported-from: test:core/LocatorQueryTest.kt
import { describe, expect, it } from 'vitest'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { IllegalArgumentException } from '../../src/core/inspector/illegalArgumentException'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { LocatorGenerator } from '../../src/core/inspector/locators'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect } from '../../src/core/model'
import { fixture } from '../helpers/fixtures'

const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))
const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

describe('LocatorQueryTest', () => {
  it('finds elements with mobilewright locators', () => {
    const byId = LocatorQuery.find("screen.getByTestId('com.example.app:id/email')", android)
    expect(byId.length).toBe(1)
    expect(byId[0].resourceId).toBe('com.example.app:id/email')
    expect(LocatorQuery.find('getByTestId("email-input")', ios).length).toBe(1)
  })

  it('every suggested locator finds its own node', () => {
    for (const root of [android, ios]) {
      const node = [...root.walk()].find((it) => !it.isRoot && it.children.length === 0 && (it.resourceId !== undefined || it.identifier !== undefined))!
      LocatorGenerator.suggest(node, root)
        .filter((it) => it.framework === 'Mobilewright' || it.strategy.startsWith('xpath'))
        .forEach((suggestion) => {
          const found = LocatorQuery.find(suggestion.expression, root)
          expect(found.some((it) => it === node), `${suggestion.expression} should find the node`).toBe(true)
          expect(found.length, suggestion.expression).toBe(suggestion.matchCount)
        })
    }
  })

  it('absolute xpath finds exactly one node', () => {
    const node = [...android.walk()].find((it) => it.resourceId === 'com.example.app:id/email')!
    const found = LocatorQuery.find(node.absoluteXPath(), android)
    expect(found.length).toBe(1)
    expect(found[0]).toBe(node)
  })

  it('no match gives an empty list', () => {
    expect(LocatorQuery.find("screen.getByTestId('nope')", android)).toEqual([])
    expect(LocatorQuery.find('//does.not.Exist', android)).toEqual([])
  })

  it('unknown syntax is rejected', () => {
    expect(() => LocatorQuery.find('click the button', android)).toThrow(IllegalArgumentException)
  })

  it('broken xpath is rejected', () => {
    expect(() => LocatorQuery.find('//node[', android)).toThrow(IllegalArgumentException)
  })

  it('an absolute path of a deeply nested element is found without the xpath engine', () => {
    let parent = new UiNode('ANDROID', 'hierarchy', {}, undefined)
    const top = parent
    for (let i = 0; i < 60; i++) {
      const next = new UiNode('ANDROID', 'android.view.ViewGroup', {}, rect(0, 0, 10, 10))
      parent.addChild(next)
      parent = next
    }
    const leaf = new UiNode('ANDROID', 'android.widget.Button', { text: 'deep' }, rect(0, 0, 5, 5))
    parent.addChild(leaf)
    const path = leaf.absoluteXPath()
    expect([...path].filter((c) => c === '/').length).toBeGreaterThan(60)
    const found = LocatorQuery.find(path, top)
    expect(found.length).toBe(1)
    expect(found[0]).toBe(leaf)
    // A segment that does not exist finds nothing.
    expect(LocatorQuery.find(path.replace('Button[1]', 'Button[2]'), top)).toEqual([])
  })
})
