// ported-from: test:core/WebdriverIoTest.kt
import { describe, expect, it } from 'vitest'
import { LocatorSuggestion, MobilewrightLocators, type Derived } from '../../src/core/inspector/locators'
import type { Platform } from '../../src/core/model'
import { LocatorCode, LocatorLanguage, WebdriverIo } from '../../src/core/pageobject/locatorCode'
import { AppiumStrategy, PageLocator } from '../../src/core/pageobject/pageObject'
import { RecorderOutput } from '../../src/core/recording/appiumSteps'
import { Assertion, WaitState } from '../../src/core/recording/assertion'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { WebdriverIoSteps } from '../../src/core/recording/webdriverIoSteps'

const Kind = MobilewrightLocators.Kind
const derived = (kind: Derived['kind'], value: string): Derived => ({ kind, value })
const Target = ScriptRecorder.Target
const S = ScriptRecorder

const row = (strategy: string, value: string) => new LocatorSuggestion('Appium', strategy, value, 1)
const l = (s: AppiumStrategy, v: string) => new PageLocator.Appium(s, v)
const target = (s: AppiumStrategy = AppiumStrategy.ACCESSIBILITY_ID, v = 'login') => new Target(derived(Kind.TEST_ID, v), undefined, undefined, l(s, v))

const lines = (step: ScriptRecorder.Step, p: Platform = 'ANDROID') => WebdriverIoSteps.lines(step, p)
const one = (step: ScriptRecorder.Step, p: Platform = 'ANDROID') => {
  const out = lines(step, p)
  expect(out.length).toBe(1)
  return out[0]
}

describe('WebdriverIoTest', () => {
  // ---- locators

  it('selectors per strategy', () =>
    expect(
      [
        l(AppiumStrategy.ID, 'com.example:id/email'),
        l(AppiumStrategy.ACCESSIBILITY_ID, 'Log in'),
        l(AppiumStrategy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("x")'),
        l(AppiumStrategy.IOS_PREDICATE, "name == 'a'"),
        l(AppiumStrategy.IOS_CLASS_CHAIN, '**/XCUIElementTypeButton'),
        l(AppiumStrategy.XPATH, '//Card//Button'),
      ].map((it) => WebdriverIo.element(it)),
    ).toEqual([
      "$('id=com.example:id/email')",
      "$('~Log in')",
      "$('android=new UiSelector().text(\"x\")')",
      "$('-ios predicate string:name == \\'a\\'')",
      "$('-ios class chain:**/XCUIElementTypeButton')",
      "$('//Card//Button')",
    ]))

  it('quote escapes backslash quote and newline', () => expect(WebdriverIo.quote("a\\b'c\nd")).toBe("'a\\\\b\\'c\\nd'"))

  it('locator language renders appium rows only', () => {
    const language = LocatorLanguage.APPIUM_WEBDRIVERIO
    expect(LocatorCode.render(row('accessibility id', 'login'), language)).toBe("$('~login')")
    expect(LocatorCode.render(row('xpath (in parent)', '//a'), language)).toBe("$('//a')")
    expect(LocatorCode.render(new LocatorSuggestion('Mobilewright', 'testId', "screen.getByTestId('x')", 1), language)).toBeUndefined()
  })

  it('locator language note and menu label', () => {
    const mw = new LocatorSuggestion('Mobilewright', 'testId', "screen.getByTestId('x')", 1)
    const text = LocatorCode.textFor(mw, LocatorLanguage.APPIUM_WEBDRIVERIO)
    expect(text.text).toBe(mw.expression)
    expect(text.note!.includes('Appium JavaScript (WebdriverIO)')).toBe(true)
    expect(LocatorCode.menuLabel(row('id', 'a'), LocatorLanguage.APPIUM_WEBDRIVERIO)).toBe('Copy Appium JavaScript (WebdriverIO) id')
  })

  it('old persisted names still load', () => {
    expect(LocatorLanguage.fromName('APPIUM_PYTHON')).toBe(LocatorLanguage.APPIUM_PYTHON)
    expect(LocatorLanguage.fromName('APPIUM_WEBDRIVERIO')).toBe(LocatorLanguage.APPIUM_WEBDRIVERIO)
    expect(RecorderOutput.fromName('APPIUM_CSHARP')).toBe(RecorderOutput.APPIUM_CSHARP)
    expect(RecorderOutput.fromName('APPIUM_WEBDRIVERIO')).toBe(RecorderOutput.APPIUM_WEBDRIVERIO)
    expect(RecorderOutput.fromName('unknown')).toBe(RecorderOutput.MOBILEWRIGHT)
  })

  // ---- steps

  it('tap and fill', () => {
    expect(one(new S.Tap(target()))).toBe("await $('~login').click();")
    expect(one(new S.Fill(target(), "a'b"))).toBe("await $('~login').setValue('a\\'b');")
  })

  it('unverified tap gets a note', () =>
    expect(one(new S.Tap(target(), true)).endsWith('// check: matched against the screen before the previous action')).toBe(true))

  it('step without appium locator is a comment', () => {
    const none = new Target(derived(Kind.TEXT, 'Hi'))
    expect(one(new S.Tap(none)).startsWith('// tap ')).toBe(true)
    expect(one(new S.Expect(none, Assertion.Visible)).startsWith('// expect ')).toBe(true)
  })

  it('long press and double tap per platform', () => {
    expect(one(new S.LongPress(target(), 700))).toBe("await driver.execute('mobile: longClickGesture', { elementId: (await $('~login')).elementId, duration: 700 });")
    expect(one(new S.LongPress(target(), 700), 'IOS')).toBe("await driver.execute('mobile: touchAndHold', { elementId: (await $('~login')).elementId, duration: 0.7 });")
    expect(one(new S.DoubleTap(target()))).toBe("await driver.execute('mobile: doubleClickGesture', { elementId: (await $('~login')).elementId });")
    expect(one(new S.DoubleTap(target()), 'IOS')).toBe("await driver.execute('mobile: doubleTap', { elementId: (await $('~login')).elementId });")
  })

  it('swipe per platform', () => {
    expect(one(new S.Swipe('up'))).toBe(
      "await driver.execute('mobile: swipeGesture', { left: 0, top: 0, width: (await driver.getWindowSize()).width, height: (await driver.getWindowSize()).height, direction: 'up', percent: 0.75 });",
    )
    expect(one(new S.Swipe('up'), 'IOS')).toBe("await driver.execute('mobile: swipe', { direction: 'up' });")
  })

  it('scroll until visible loops', () => {
    expect(lines(new S.ScrollUntilVisible(target(), 'up', 5), 'IOS')).toEqual([
      "for (let i = 0; i < 5 && !(await $('~login').isDisplayed()); i++) {",
      "    await driver.execute('mobile: swipe', { direction: 'up' });",
      '}',
    ])
  })

  it('assertions', () => {
    const e = (a: Assertion, t?: number, p: Platform = 'ANDROID') => one(new S.Expect(target(), a, t), p)
    expect(e(Assertion.Visible)).toBe("await expect($('~login')).toBeDisplayed();")
    expect(e(Assertion.Visible, 5000)).toBe("await expect($('~login')).toBeDisplayed({ wait: 5000 });")
    expect(e(Assertion.Hidden)).toBe("await expect($('~login')).not.toBeDisplayed();")
    expect(e(new Assertion.HasText('Hi'))).toBe("await expect($('~login')).toHaveText('Hi');")
    expect(e(new Assertion.HasText('Hi'), 2000)).toBe("await expect($('~login')).toHaveText('Hi', { wait: 2000 });")
    expect(e(new Assertion.ContainsText('Hi'))).toBe("await expect($('~login')).toHaveText(expect.stringContaining('Hi'));")
    expect(e(new Assertion.HasValue('v'))).toBe("await expect($('~login')).toHaveText('v');")
    expect(e(new Assertion.HasValue('v'), undefined, 'IOS')).toBe("await expect($('~login')).toHaveAttribute('value', 'v');")
    expect(e(new Assertion.Enabled(true))).toBe("await expect($('~login')).toBeEnabled();")
    expect(e(new Assertion.Enabled(false), 1000)).toBe("await expect($('~login')).not.toBeEnabled({ wait: 1000 });")
    expect(e(Assertion.Checked)).toBe("await expect($('~login')).toHaveAttribute('checked', 'true');")
    expect(e(Assertion.Checked, undefined, 'IOS')).toBe("await expect($('~login')).toHaveAttribute('value', '1');")
  })

  it('waits', () => {
    const w = (s: WaitState, t?: number) => one(new S.WaitFor(target(), s, t))
    expect(w(WaitState.VISIBLE)).toBe("await $('~login').waitForDisplayed({ timeout: 10000 });")
    expect(w(WaitState.HIDDEN, 3000)).toBe("await $('~login').waitForDisplayed({ reverse: true, timeout: 3000 });")
    expect(w(WaitState.ENABLED)).toBe("await $('~login').waitForEnabled({ timeout: 10000 });")
    expect(w(WaitState.DISABLED)).toBe("await $('~login').waitForEnabled({ reverse: true, timeout: 10000 });")
  })

  it('buttons back count and notes', () => {
    expect(one(new S.Button('HOME'))).toBe("await driver.execute('mobile: pressKey', { keycode: 3 });")
    expect(one(new S.Button('HOME'), 'IOS')).toBe("await driver.execute('mobile: pressButton', { name: 'home' });")
    expect(one(new S.Button('VOLUME_UP'))).toBe('// press button VOLUME_UP: no Appium form')
    expect(one(S.GoBack)).toBe('await driver.back();')
    expect(one(new S.ExpectCount(target(), 3)).startsWith('// expect count 3 of ')).toBe(true)
    expect(one(new S.UnfocusedText('x'))).toBe("// typed 'x': tap the field first so it can be recorded as fill")
    expect(one(new S.Note('hello'))).toBe('// hello')
  })

  // ---- render and output

  it('render adds the import comment only when there is code', () => {
    const out = WebdriverIoSteps.render([new S.Tap(target())], 'ANDROID')
    expect(out).toBe("// import { $, driver, expect } from '@wdio/globals';\nawait $('~login').click();")
    expect(WebdriverIoSteps.render([new S.Note('hello')], 'ANDROID')).toBe('// hello')
  })

  it('recorder output webdriverio', () => {
    const out = RecorderOutput.APPIUM_WEBDRIVERIO
    const step = new S.Tap(target())
    expect(out.summary(step, 'ANDROID')).toBe("await $('~login').click();")
    expect(out.render([step], 'ANDROID').endsWith("await $('~login').click();")).toBe(true)
  })
})
