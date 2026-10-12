// ported-from: test:core/LocatorHintTest.kt
import { describe, expect, it } from 'vitest'
import { LocatorHints, LocatorSuggestion } from '../../src/core/inspector/locators'

const suggestion = (framework: string, strategy: string, matches: number) => new LocatorSuggestion(framework, strategy, 'x', matches)
const xpath = (expr: string, strategy = 'xpath') => new LocatorSuggestion('Appium', strategy, expr, 1)

describe('LocatorHintTest', () => {
  it('a unique test id has no hint', () => {
    expect(suggestion('Mobilewright', 'test id', 1).hint).toBeUndefined()
  })

  it('a locator that matches nothing or several elements says so', () => {
    expect(suggestion('Mobilewright', 'test id', 0).hint!).toContain('nothing')
    expect(suggestion('Mobilewright', 'role', 16).hint!).toContain('16')
  })

  it('fragile but unique locators are flagged', () => {
    expect(suggestion('Appium', 'xpath (absolute)', 1).hint).toBeDefined()
    expect(suggestion('Mobilewright', 'label', 1).hint!).toContain('language')
    expect(suggestion('Mobilewright', 'text', 1).hint!).toContain('language')
  })

  it('text based appium strategies are not flagged by the mobilewright rule', () => {
    expect(suggestion('Appium', 'id', 1).hint).toBeUndefined()
  })

  it('index based xpath is detected', () => {
    expect(LocatorHints.isIndexBased('//android.widget.Button[3]')).toBe(true)
    expect(LocatorHints.isIndexBased('(//android.widget.Button)[2]')).toBe(true)
    expect(LocatorHints.isIndexBased('//a[ last() ]')).toBe(true)
    expect(LocatorHints.isIndexBased('//a[last()-1]')).toBe(true)
    expect(LocatorHints.isIndexBased('//a[position()=2]')).toBe(true)
    expect(LocatorHints.isIndexBased('//a[@index="1"]')).toBe(true)
    expect(LocatorHints.isIndexBased('//a[@text="Item [3]"]')).toBe(false)
    expect(LocatorHints.isIndexBased("//a[@resource-id='x']")).toBe(false)
  })

  it('an index based xpath gets a hint', () => {
    expect(xpath('(//a[@text="x"])[2]').hint!).toContain('Index')
    expect(xpath('//a[@text="x"]').hint).toBeUndefined()
    expect(new LocatorSuggestion('Appium', 'id', 'a[3]', 1).hint).toBeUndefined()
  })

  it('no alternative is named without a warning', () => {
    const good = suggestion('Mobilewright', 'test id', 1)
    expect(LocatorHints.hintWithAlternative(good, [good])).toBeUndefined()
  })

  it('the next best unique locator without warning is named', () => {
    const bad = xpath('//a[3]')
    const dup = new LocatorSuggestion('Appium', 'id', 'dup', 2)
    const fragile = xpath('/hierarchy/a', 'xpath (absolute)')
    const good = new LocatorSuggestion('Appium', 'accessibility id', 'login', 1)
    const mw = new LocatorSuggestion('Mobilewright', 'test id', "screen.getByTestId('x')", 1)
    const text = LocatorHints.hintWithAlternative(bad, [mw, bad, dup, fragile, good])!
    expect(text).toContain('Index based')
    expect(text).toContain('Next best: accessibility id, login')
    // Without a same framework candidate, another framework is used and named.
    const other = LocatorHints.hintWithAlternative(bad, [mw, bad, dup])!
    expect(other).toContain('Next best: Mobilewright test id')
  })

  it('the hint stays plain when there is no alternative', () => {
    const bad = xpath('//a[3]')
    expect(LocatorHints.hintWithAlternative(bad, [bad, new LocatorSuggestion('Appium', 'id', 'd', 2)])).toBe(bad.hint)
  })
})
