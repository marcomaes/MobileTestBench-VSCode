// ported-from: test:core/ScopedLocatorsTest.kt
// The cases of ScopedLocatorsTest that need ScriptRecorder (the rest is in scopedLocators.test.ts): the three recorder tests and the
// whole `a card that is a sibling of its button in a flattened tree is still a parent`, whose tail uses the recorder.
import { describe, expect, it } from 'vitest'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { LocatorGenerator } from '../../src/core/inspector/locators'
import { ScopedLocators } from '../../src/core/inspector/scopedLocators'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect, type Rect } from '../../src/core/model'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'

function el(type: string, name: string | undefined, label: string | undefined, r: Rect): UiNode {
  const attrs: Record<string, string> = {}
  if (name !== undefined) attrs.name = name
  if (label !== undefined) attrs.label = label
  attrs.visible = 'true'
  return new UiNode('IOS', `XCUIElementType${type}`, attrs, r)
}

function fixtureTree() {
  const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
  const cards = [1, 2, 3].map((i) => {
    const c = el('Other', `product-item-${i}`, `Product ${i}`, rect(0, (i - 1) * 100, 400, 100))
    root.addChild(c)
    return c
  })
  const buttons = cards.map((card, i) => {
    const b = el('Button', 'add-to-cart', 'Add to cart', rect(300, i * 100 + 50, 80, 40))
    card.addChild(b)
    return b
  })
  return { root, cards, buttons }
}

describe('ScopedLocatorsTest recorder', () => {
  it('the recorder uses the parent instead of an index and replay finds the same element', () => {
    const { root, buttons } = fixtureTree()
    const recorder = new ScriptRecorder('IOS')
    recorder.tap(root, 340, 170) // second button
    expect(recorder.code()).toBe("await screen.getByTestId('product-item-2').getByTestId('add-to-cart').tap();")
    const target = (recorder.steps[0] as ScriptRecorder.Tap).target
    expect(recorder.steps.length).toBe(1)
    expect(target.parent).toBeDefined()
    expect(target.nth).toBeUndefined()
    expect(target.resolve(root)).toBe(buttons[1])
    // The element is gone: nothing to find.
    expect(target.resolve(new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined))).toBeUndefined()
  })

  it('without any helpful parent the recorder still falls back to an index', () => {
    const flat = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    for (let i = 0; i < 2; i++) flat.addChild(el('Button', 'ok', 'OK', rect(0, i * 60, 80, 40)))
    const recorder = new ScriptRecorder('IOS')
    recorder.tap(flat, 10, 70)
    expect(recorder.code()).toBe("await screen.getByTestId('ok').nth(1).tap();")
  })

  it('a card that is a sibling of its button in a flattened tree is still a parent', () => {
    const flat = new UiNode('ANDROID', 'hierarchy', {}, undefined)
    const list = new UiNode('ANDROID', 'android.widget.ScrollView', { 'resource-id': 'product-list' }, rect(0, 0, 1000, 1000))
    flat.addChild(list)
    const buttons = [1, 2, 3].map((i) => {
      // The card is an empty sibling; its button comes later in the same list and lies inside its bounds.
      list.addChild(new UiNode('ANDROID', 'android.view.ViewGroup', { 'resource-id': `product-item-${i}` }, rect(40, (i - 1) * 300, 920, 280)))
      const b = new UiNode('ANDROID', 'android.view.ViewGroup', { 'resource-id': 'add-to-cart-button', 'content-desc': 'Add product to cart' }, rect(400, (i - 1) * 300 + 150, 400, 100))
      list.addChild(b)
      return b
    })
    const scoped = ScopedLocators.forNode(buttons[1], flat)!
    expect(scoped.code()).toBe("screen.getByTestId('product-item-2').getByTestId('add-to-cart-button')")
    expect(LocatorQuery.find(scoped.code(), flat)).toEqual([buttons[1]])
    const suggestions = LocatorGenerator.suggest(buttons[1], flat)
    expect(suggestions[0].strategy).toBe('test id in parent')
    // The card is a preceding sibling of its button: the XPath names the card and walks to the next matching sibling.
    const xpath = suggestions.find((it) => it.strategy === 'xpath (in parent)')!
    expect(xpath.expression).toBe('//android.view.ViewGroup[@resource-id="product-item-2"]/following-sibling::android.view.ViewGroup[@resource-id="add-to-cart-button"][1]')
    const found = LocatorQuery.find(xpath.expression, flat)
    expect(found.length).toBe(1)
    expect(found[0]).toBe(buttons[1])
    expect(xpath.matchCount).toBe(1)
    const recorder = new ScriptRecorder('ANDROID')
    recorder.tap(flat, 600, 500)
    expect(recorder.code()).toBe("await screen.getByTestId('product-item-2').getByTestId('add-to-cart-button').tap();")
  })

  it('a tap on the text inside a duplicate button records the buttons scoped test id', () => {
    const flat = new UiNode('ANDROID', 'hierarchy', {}, undefined)
    const list = new UiNode('ANDROID', 'android.widget.ScrollView', { 'resource-id': 'product-list' }, rect(0, 0, 1000, 1000))
    flat.addChild(list)
    for (const i of [1, 2]) {
      list.addChild(new UiNode('ANDROID', 'android.view.ViewGroup', { 'resource-id': `product-item-${i}` }, rect(40, (i - 1) * 400, 920, 380)))
      const button = new UiNode(
        'ANDROID',
        'android.view.ViewGroup',
        { 'resource-id': 'add-to-cart-button', 'content-desc': 'Add product to cart', clickable: 'true' },
        rect(400, (i - 1) * 400 + 200, 400, 100),
      )
      list.addChild(button)
      button.addChild(new UiNode('ANDROID', 'android.widget.TextView', { text: 'Add to Cart' }, rect(500, (i - 1) * 400 + 230, 200, 40)))
    }
    const recorder = new ScriptRecorder('ANDROID')
    recorder.tap(flat, 600, 650) // the text inside the second button
    expect(recorder.code()).toBe("await screen.getByTestId('product-item-2').getByTestId('add-to-cart-button').tap();")
  })
})
