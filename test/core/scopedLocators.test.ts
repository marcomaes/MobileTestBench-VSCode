// ported-from: test:core/ScopedLocatorsTest.kt
// Skipped (need ScriptRecorder, outside this scope): `the recorder uses the parent instead of an index and replay finds the same
// element`, `without any helpful parent the recorder still falls back to an index`, `a tap on the text inside a duplicate button
// records the buttons scoped test id`, and the final ScriptRecorder lines of `a card that is a sibling of its button in a flattened tree is still a parent`.
import { describe, expect, it } from 'vitest'
import { IllegalArgumentException } from '../../src/core/inspector/illegalArgumentException'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { LocatorGenerator } from '../../src/core/inspector/locators'
import { ScopedLocators } from '../../src/core/inspector/scopedLocators'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect, type Rect } from '../../src/core/model'

/** A product list: every card has the same "add-to-cart" button, only the cards have their own test id. */
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

describe('ScopedLocatorsTest', () => {
  it('a duplicate test id is scoped by the card it is in', () => {
    const { root, cards, buttons } = fixtureTree()
    const scoped = ScopedLocators.forNode(buttons[1], root)!
    expect(scoped.code()).toBe("screen.getByTestId('product-item-2').getByTestId('add-to-cart')")
    expect(scoped.parentNode).toBe(cards[1])
  })

  it('the suggestions put the scoped locator first and keep the plain one', () => {
    const { root, buttons } = fixtureTree()
    const suggestions = LocatorGenerator.suggest(buttons[1], root)
    const first = suggestions[0]
    expect(first.strategy).toBe('test id in parent')
    expect(first.expression).toBe("screen.getByTestId('product-item-2').getByTestId('add-to-cart')")
    expect(first.isBest && first.isUnique).toBe(true)
    expect(first.hint).toBeUndefined()
    const plain = suggestions.find((it) => it.expression === "screen.getByTestId('add-to-cart')")!
    expect(plain.isBest).toBe(false)
    expect(plain.matchCount).toBe(3)
    const xpath = suggestions.find((it) => it.strategy === 'xpath (in parent)')!
    expect(xpath.expression).toBe('//XCUIElementTypeOther[@name="product-item-2"]//XCUIElementTypeButton[@name="add-to-cart"]')
    expect(LocatorQuery.find(xpath.expression, root)).toEqual([buttons[1]])
    expect(LocatorQuery.find(xpath.expression, root)[0]).toBe(buttons[1])
  })

  it('a locator that is already unique gets no scoped variant', () => {
    const { root, cards } = fixtureTree()
    const suggestions = LocatorGenerator.suggest(cards[0], root)
    expect(suggestions.every((it) => !it.strategy.endsWith('in parent'))).toBe(true)
    expect(suggestions[0].isBest).toBe(true)
  })

  it('chained locators are evaluated against the parent only', () => {
    const { root, buttons } = fixtureTree()
    const found = LocatorQuery.find("screen.getByTestId('product-item-3').getByTestId('add-to-cart')", root)
    expect(found.length).toBe(1)
    expect(found[0]).toBe(buttons[2])
    expect(LocatorQuery.find("screen.getByTestId('add-to-cart')", root).length).toBe(3)
    expect(LocatorQuery.find("screen.getByTestId('add-to-cart').first()", root)).toEqual([buttons[0]])
    expect(LocatorQuery.find("getByTestId('add-to-cart').nth(2)", root)[0]).toBe(buttons[2])
    expect(LocatorQuery.find("screen.getByTestId('add-to-cart').last()", root)[0]).toBe(buttons[2])
    expect(LocatorQuery.find("screen.getByTestId('nope').getByTestId('add-to-cart')", root)).toEqual([])
  })

  it('bad chains are rejected with a readable message', () => {
    const { root } = fixtureTree()
    expect(() => LocatorQuery.find("screen.getByTestId('a').tap()", root)).toThrow(IllegalArgumentException)
    expect(() => LocatorQuery.find("screen.getByTestId('a'", root)).toThrow(IllegalArgumentException)
    expect(() => LocatorQuery.find("screen.getByTestId('a').nth(x)", root)).toThrow(IllegalArgumentException)
  })

  it('parentheses and quotes inside a value do not confuse the parser', () => {
    const { root } = fixtureTree()
    const odd = el('Button', 'x', "Say (hi), 'you'", rect(0, 500, 50, 20))
    root.addChild(odd)
    const found = LocatorQuery.find("screen.getByLabel('Say (hi), \\'you\\'')", root)
    expect(found.length).toBe(1)
    expect(found[0]).toBe(odd)
  })

  it('every suggested locator finds its own element', () => {
    const { root, cards, buttons } = fixtureTree()
    for (const node of [...buttons, ...cards]) {
      LocatorGenerator.suggest(node, root)
        .filter((it) => it.framework === 'Mobilewright' || it.strategy.startsWith('xpath'))
        .forEach((s) => {
          const found = LocatorQuery.find(s.expression, root)
          expect(found.some((it) => it === node), `${s.expression} should find the element`).toBe(true)
          expect(found.length, s.expression).toBe(s.matchCount)
        })
    }
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
    expect(LocatorQuery.find(xpath.expression, flat)[0]).toBe(buttons[1])
    expect(xpath.matchCount).toBe(1)
  })

  it('when the parent comes after the element a preceding axis is used', () => {
    const screen = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    const list = el('Other', 'list', undefined, rect(0, 0, 400, 600))
    screen.addChild(list)
    const buttons = [0, 1].map((i) => {
      const b = el('Button', 'buy', 'Buy', rect(300, i * 200 + 120, 80, 40))
      list.addChild(b)
      list.addChild(el('Other', `row-${i}`, `Row ${i}`, rect(0, i * 200, 400, 200))) // the row comes after its button
      return b
    })
    const xpath = LocatorGenerator.suggest(buttons[1], screen).find((it) => it.strategy === 'xpath (in parent)')!
    expect(xpath.expression).toBe('//XCUIElementTypeOther[@name="row-1"]/preceding-sibling::XCUIElementTypeButton[@name="buy"][1]')
    expect(LocatorQuery.find(xpath.expression, screen)[0]).toBe(buttons[1])
  })
})
