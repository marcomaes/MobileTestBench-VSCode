// ported-from: test:core/LocatorCodeTest.kt
import { describe, expect, it } from 'vitest'
import { LocatorSuggestion } from '../../src/core/inspector/locators'
import { LocatorCode, LocatorLanguage } from '../../src/core/pageobject/locatorCode'
import { AppiumStrategy } from '../../src/core/pageobject/pageObject'

const appium = (strategy: string, value: string) => new LocatorSuggestion('Appium', strategy, value, 1)
const mw = new LocatorSuggestion('Mobilewright', 'testId', "screen.getByTestId('login')", 1)

const rows = [
  appium('id', 'com.example:id/email'),
  appium('accessibility id', 'Log "in"'),
  appium('-android uiautomator', 'new UiSelector().text("$x")'),
  appium('-ios predicate string', "name == 'a'"),
  appium('-ios class chain', "**/XCUIElementTypeButton[`name == 'a'`]"),
  appium('xpath', '//Button[@text="a"]'),
  appium('xpath (in parent)', '//Card//Button'),
]

const all = (language: LocatorLanguage) => rows.map((it) => LocatorCode.render(it, language))

describe('LocatorCodeTest', () => {
  it('java', () =>
    expect(all(LocatorLanguage.APPIUM_JAVA)).toEqual([
      'By.id("com.example:id/email")',
      'AppiumBy.accessibilityId("Log \\"in\\"")',
      'AppiumBy.androidUIAutomator("new UiSelector().text(\\"$x\\")")',
      'AppiumBy.iOSNsPredicateString("name == \'a\'")',
      'AppiumBy.iOSClassChain("**/XCUIElementTypeButton[`name == \'a\'`]")',
      'By.xpath("//Button[@text=\\"a\\"]")',
      'By.xpath("//Card//Button")',
    ]))

  it('kotlin escapes dollar', () => {
    const out = all(LocatorLanguage.APPIUM_KOTLIN)
    expect(out[2]).toBe('AppiumBy.androidUIAutomator("new UiSelector().text(\\"\\$x\\")")')
    expect(out[0]).toBe('By.id("com.example:id/email")')
  })

  it('python tuples', () => {
    const out = all(LocatorLanguage.APPIUM_PYTHON)
    expect(out[0]).toBe('(AppiumBy.ID, "com.example:id/email")')
    expect(out[1]).toBe('(AppiumBy.ACCESSIBILITY_ID, "Log \\"in\\"")')
    expect(out[2]).toBe('(AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\\"$x\\")")')
    expect(out[3]).toBe('(AppiumBy.IOS_PREDICATE, "name == \'a\'")')
    expect(out[4]).toBe('(AppiumBy.IOS_CLASS_CHAIN, "**/XCUIElementTypeButton[`name == \'a\'`]")')
    expect(out[5]).toBe('(AppiumBy.XPATH, "//Button[@text=\\"a\\"]")')
    expect(out[6]).toBe('(AppiumBy.XPATH, "//Card//Button")')
  })

  it('csharp uses MobileBy', () => {
    const out = all(LocatorLanguage.APPIUM_CSHARP)
    expect(out[0]).toBe('By.Id("com.example:id/email")')
    expect(out[1]).toBe('MobileBy.AccessibilityId("Log \\"in\\"")')
    expect(out[2]).toBe('MobileBy.AndroidUIAutomator("new UiSelector().text(\\"$x\\")")')
    expect(out[3]).toBe('MobileBy.IosNSPredicate("name == \'a\'")')
    expect(out[4]).toBe('MobileBy.IosClassChain("**/XCUIElementTypeButton[`name == \'a\'`]")')
    expect(out[5]).toBe('By.XPath("//Button[@text=\\"a\\"]")')
  })

  const line = (row: number, l: LocatorLanguage) => LocatorCode.render(rows[row], l, true)

  it('whole line for every language', () => {
    expect(line(0, LocatorLanguage.APPIUM_JAVA)).toBe('driver.findElement(By.id("com.example:id/email"))')
    expect(line(1, LocatorLanguage.APPIUM_KOTLIN)).toBe('driver.findElement(AppiumBy.accessibilityId("Log \\"in\\""))')
    expect(line(0, LocatorLanguage.APPIUM_PYTHON)).toBe('driver.find_element(AppiumBy.ID, "com.example:id/email")')
    expect(line(6, LocatorLanguage.APPIUM_PYTHON)).toBe('driver.find_element(AppiumBy.XPATH, "//Card//Button")')
    expect(line(1, LocatorLanguage.APPIUM_CSHARP)).toBe('driver.FindElement(MobileBy.AccessibilityId("Log \\"in\\""))')
    expect(line(0, LocatorLanguage.APPIUM_WEBDRIVERIO)).toBe("await $('id=com.example:id/email')")
    expect(LocatorCode.render(mw, LocatorLanguage.MOBILEWRIGHT, true)).toBe("screen.getByTestId('login')")
    expect(line(0, LocatorLanguage.AS_SHOWN)).toBe('com.example:id/email')
  })

  it('whole line keeps missing forms missing and textFor passes it on', () => {
    expect(LocatorCode.render(mw, LocatorLanguage.APPIUM_JAVA, true)).toBeUndefined()
    expect(LocatorCode.textFor(rows[0], LocatorLanguage.APPIUM_JAVA, true).text).toBe('driver.findElement(By.id("com.example:id/email"))')
    expect(LocatorCode.textFor(rows[0], LocatorLanguage.APPIUM_JAVA).text).toBe('By.id("com.example:id/email")')
  })

  it('as shown and mobilewright keep the expression', () => {
    expect(LocatorCode.render(mw, LocatorLanguage.AS_SHOWN)).toBe("screen.getByTestId('login')")
    expect(LocatorCode.render(mw, LocatorLanguage.MOBILEWRIGHT)).toBe("screen.getByTestId('login')")
    expect(LocatorCode.render(rows[0], LocatorLanguage.AS_SHOWN)).toBe('com.example:id/email')
  })

  it('rows without a form in the language give null and fall back as shown with a note', () => {
    for (const l of [LocatorLanguage.APPIUM_JAVA, LocatorLanguage.APPIUM_KOTLIN, LocatorLanguage.APPIUM_PYTHON, LocatorLanguage.APPIUM_CSHARP]) {
      expect(LocatorCode.render(mw, l)).toBeUndefined()
    }
    expect(LocatorCode.render(rows[0], LocatorLanguage.MOBILEWRIGHT)).toBeUndefined()
    const t = LocatorCode.textFor(mw, LocatorLanguage.APPIUM_JAVA)
    expect(t.text).toBe("screen.getByTestId('login')")
    expect(t.note).toBe('No Appium Java form for a Mobilewright locator, used as shown')
    expect(LocatorCode.textFor(rows[0], LocatorLanguage.MOBILEWRIGHT).note).toBeDefined()
    expect(LocatorCode.textFor(rows[0], LocatorLanguage.APPIUM_JAVA).note).toBeUndefined()
  })

  it('menu labels name the language only when there is a form', () => {
    expect(LocatorCode.menuLabel(rows[0], LocatorLanguage.AS_SHOWN)).toBe('Copy Appium id')
    expect(LocatorCode.menuLabel(rows[0], LocatorLanguage.APPIUM_JAVA)).toBe('Copy Appium Java id')
    expect(LocatorCode.menuLabel(mw, LocatorLanguage.MOBILEWRIGHT)).toBe('Copy Mobilewright testId')
    expect(LocatorCode.menuLabel(mw, LocatorLanguage.APPIUM_JAVA)).toBe('Copy Mobilewright testId')
  })

  it('strategy names map in one place and unknown names are xpath', () => {
    expect(AppiumStrategy.fromLocatorName('accessibility id')).toBe(AppiumStrategy.ACCESSIBILITY_ID)
    expect(AppiumStrategy.fromLocatorName('xpath (in parent)')).toBe(AppiumStrategy.XPATH)
    expect(AppiumStrategy.fromLocatorName('xpath (absolute)')).toBe(AppiumStrategy.XPATH)
    expect(LocatorLanguage.fromName('nonsense')).toBe(LocatorLanguage.AS_SHOWN)
    expect(LocatorLanguage.fromName('APPIUM_PYTHON')).toBe(LocatorLanguage.APPIUM_PYTHON)
  })
})
