// ported-from: test:core/AppiumStepsTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { MobilewrightLocators, type Derived } from '../../src/core/inspector/locators'
import type { Platform } from '../../src/core/model'
import { AppiumStrategy, PageLocator, PageObjectLanguage } from '../../src/core/pageobject/pageObject'
import { AppiumSteps, RecorderOutput } from '../../src/core/recording/appiumSteps'
import { Assertion, WaitState } from '../../src/core/recording/assertion'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { fixture } from '../helpers/fixtures'

const Kind = MobilewrightLocators.Kind
const derived = (kind: Derived['kind'], value: string): Derived => ({ kind, value })
const Target = ScriptRecorder.Target

const java = PageObjectLanguage.APPIUM_JAVA
const kotlin = PageObjectLanguage.APPIUM_KOTLIN
const python = PageObjectLanguage.APPIUM_PYTHON
const csharp = PageObjectLanguage.APPIUM_CSHARP

const byId = new Target(derived(Kind.TEST_ID, 'login'), undefined, undefined, new PageLocator.Appium(AppiumStrategy.ID, 'login'))
const byAcc = new Target(derived(Kind.TEST_ID, 'login'), undefined, undefined, new PageLocator.Appium(AppiumStrategy.ACCESSIBILITY_ID, 'login'))
const none = new Target(derived(Kind.TEXT, 'Hi'))

const lines = (step: ScriptRecorder.Step, l: PageObjectLanguage, p: Platform = 'ANDROID') => AppiumSteps.lines(step, l, p)
const one = (step: ScriptRecorder.Step, l: PageObjectLanguage, p: Platform = 'ANDROID') => {
  const out = lines(step, l, p)
  expect(out.length).toBe(1)
  return out[0]
}

const S = ScriptRecorder

describe('AppiumStepsTest', () => {
  // ---- Java, one test per step type

  it('java tap', () => expect(one(new S.Tap(byId), java)).toBe('driver.findElement(By.id("login")).click();'))

  it('java fill clears first then sends keys', () =>
    expect(lines(new S.Fill(byId, 'a"b'), java)).toEqual(['driver.findElement(By.id("login")).clear();', 'driver.findElement(By.id("login")).sendKeys("a\\"b");']))

  it('java long press android and ios', () => {
    expect(one(new S.LongPress(byId, 700), java)).toBe(
      '((JavascriptExecutor) driver).executeScript("mobile: longClickGesture", Map.of("elementId", ((RemoteWebElement) driver.findElement(By.id("login"))).getId(), "duration", 700));',
    )
    expect(one(new S.LongPress(byId, 700), java, 'IOS')).toBe(
      '((JavascriptExecutor) driver).executeScript("mobile: touchAndHold", Map.of("elementId", ((RemoteWebElement) driver.findElement(By.id("login"))).getId(), "duration", 0.7));',
    )
  })

  it('java double tap android and ios', () => {
    expect(one(new S.DoubleTap(byId), java)).toBe(
      '((JavascriptExecutor) driver).executeScript("mobile: doubleClickGesture", Map.of("elementId", ((RemoteWebElement) driver.findElement(By.id("login"))).getId()));',
    )
    expect(one(new S.DoubleTap(byId), java, 'IOS')).toBe(
      '((JavascriptExecutor) driver).executeScript("mobile: doubleTap", Map.of("elementId", ((RemoteWebElement) driver.findElement(By.id("login"))).getId()));',
    )
  })

  it('java swipe android and ios', () => {
    expect(one(new S.Swipe('up'), java)).toBe(
      '((JavascriptExecutor) driver).executeScript("mobile: swipeGesture", Map.of("left", 0, "top", 0, "width", driver.manage().window().getSize().getWidth(), "height", driver.manage().window().getSize().getHeight(), "direction", "up", "percent", 0.75));',
    )
    expect(one(new S.Swipe('left'), java, 'IOS')).toBe('((JavascriptExecutor) driver).executeScript("mobile: swipe", Map.of("direction", "left"));')
  })

  it('java scroll until visible is a bounded loop', () => {
    const l = lines(new S.ScrollUntilVisible(byAcc, 'up', 10), java, 'IOS')
    expect(l[0]).toBe('for (int i = 0; i < 10 && driver.findElements(AppiumBy.accessibilityId("login")).stream().noneMatch(WebElement::isDisplayed); i++) {')
    expect(l[1]).toBe('    ((JavascriptExecutor) driver).executeScript("mobile: swipe", Map.of("direction", "up"));')
    expect(l[2]).toBe('}')
  })

  it('java visible and hidden use expected conditions', () => {
    expect(one(new S.Expect(byId, Assertion.Visible), java)).toBe('wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("login")));')
    expect(one(new S.Expect(byId, Assertion.Hidden), java)).toBe('wait.until(ExpectedConditions.invisibilityOfElementLocated(By.id("login")));')
  })

  it('java text contains value enabled checked assertions', () => {
    const el = 'wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("login")))'
    expect(one(new S.Expect(byId, new Assertion.HasText('Hi')), java)).toBe(`assertEquals("Hi", ${el}.getText());`)
    expect(one(new S.Expect(byId, new Assertion.ContainsText('Hi')), java)).toBe(`assertTrue(${el}.getText().contains("Hi"));`)
    expect(one(new S.Expect(byId, new Assertion.HasValue('x')), java)).toBe(`assertEquals("x", ${el}.getText());`)
    expect(one(new S.Expect(byId, new Assertion.HasValue('x')), java, 'IOS')).toBe(`assertEquals("x", ${el}.getAttribute("value"));`)
    expect(one(new S.Expect(byId, new Assertion.Enabled(true)), java)).toBe(`assertTrue(${el}.isEnabled());`)
    expect(one(new S.Expect(byId, new Assertion.Enabled(false)), java)).toBe(`assertFalse(${el}.isEnabled());`)
    expect(one(new S.Expect(byId, Assertion.Checked), java)).toBe(`assertEquals("true", ${el}.getAttribute("checked"));`)
    expect(one(new S.Expect(byId, Assertion.Checked), java, 'IOS')).toBe(`assertEquals("1", ${el}.getAttribute("value"));`)
  })

  it('java waits', () => {
    expect(one(new S.WaitFor(byId, WaitState.VISIBLE), java)).toBe('wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("login")));')
    expect(one(new S.WaitFor(byId, WaitState.HIDDEN), java)).toBe('wait.until(ExpectedConditions.invisibilityOfElementLocated(By.id("login")));')
    expect(one(new S.WaitFor(byId, WaitState.ENABLED), java)).toBe('wait.until(d -> d.findElement(By.id("login")).isEnabled());')
    expect(one(new S.WaitFor(byId, WaitState.DISABLED), java)).toBe('wait.until(d -> !d.findElement(By.id("login")).isEnabled());')
  })

  it('java buttons and back', () => {
    expect(one(new S.Button('HOME'), java)).toBe('((JavascriptExecutor) driver).executeScript("mobile: pressKey", Map.of("keycode", 3));')
    expect(one(new S.Button('HOME'), java, 'IOS')).toBe('((JavascriptExecutor) driver).executeScript("mobile: pressButton", Map.of("name", "home"));')
    expect(one(S.GoBack, java)).toBe('driver.navigate().back();')
  })

  it('notes and unfocused text are comments', () => {
    expect(one(new S.Note('pressed ENTER'), java)).toBe('// pressed ENTER')
    expect(one(new S.UnfocusedText('abc'), java)).toBe('// typed "abc": tap the field first so it can be recorded as fill')
    expect(one(new S.Note('pressed ENTER'), python)).toBe('# pressed ENTER')
  })

  it('a drag note does not blame mobilewright', () => {
    const note = new S.Note('drag with hold (500 ms) from (1, 2) to (3, 4): Mobilewright has no drag API, not replayable')
    expect(one(note, java)).toBe('// drag with hold (500 ms) from (1, 2) to (3, 4): no Appium form recorded (a drag needs an element to drag)')
  })

  it('a step without a unique appium locator is a comment, never coordinates', () => {
    const c = one(new S.Tap(none), java)
    expect(c.startsWith("// tap screen.getByText('Hi'): no unique Appium locator"), c).toBe(true)
    for (const step of [
      new S.LongPress(none, 700),
      new S.DoubleTap(none),
      new S.Fill(none, 'x'),
      new S.Expect(none, Assertion.Visible),
      new S.WaitFor(none, WaitState.VISIBLE),
      new S.ScrollUntilVisible(none, 'up', 5),
    ]) {
      const out = one(step, java)
      expect(out.startsWith('// ') && out.includes('no unique Appium locator'), out).toBe(true)
    }
  })

  it('count assertions have no appium form', () => {
    expect(one(new S.ExpectCount(byId, 3), java).startsWith('// expect count 3 of')).toBe(true)
  })

  it('an unverified step keeps its warning', () => {
    expect(one(new S.Tap(byId, true), java)).toBe('driver.findElement(By.id("login")).click();  // check: matched against the screen before the previous action')
    expect(one(new S.Tap(byId, true), python).includes('  # check:')).toBe(true)
  })

  // ---- strategies

  it('every strategy is rendered through the shared locator code', () => {
    const tap = (s: AppiumStrategy, v: string) => one(new S.Tap(new Target(derived(Kind.TEXT, 'x'), undefined, undefined, new PageLocator.Appium(s, v))), java)
    expect(tap(AppiumStrategy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("a")')).toBe('driver.findElement(AppiumBy.androidUIAutomator("new UiSelector().text(\\"a\\")")).click();')
    expect(tap(AppiumStrategy.IOS_PREDICATE, "label == 'a'")).toBe('driver.findElement(AppiumBy.iOSNsPredicateString("label == \'a\'")).click();')
    expect(tap(AppiumStrategy.XPATH, '//a')).toBe('driver.findElement(By.xpath("//a")).click();')
  })

  // ---- Kotlin

  it('kotlin steps', () => {
    expect(one(new S.Tap(byId), kotlin)).toBe('driver.findElement(By.id("login")).click()')
    expect(lines(new S.Fill(byId, 'a$b'), kotlin).map((it) => it.replaceAll('\\$', () => '$'))).toEqual(['driver.findElement(By.id("login")).clear()', 'driver.findElement(By.id("login")).sendKeys("a$b")'])
    expect(one(new S.LongPress(byId, 700), kotlin)).toBe(
      '(driver as JavascriptExecutor).executeScript("mobile: longClickGesture", mapOf("elementId" to (driver.findElement(By.id("login")) as RemoteWebElement).id, "duration" to 700))',
    )
    expect(one(new S.Expect(byId, new Assertion.HasText('Hi')), kotlin)).toBe('assertEquals("Hi", wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("login"))).text)')
    expect(one(new S.WaitFor(byId, WaitState.ENABLED), kotlin)).toBe('wait.until { it.findElement(By.id("login")).isEnabled }')
    expect(one(S.GoBack, kotlin)).toBe('driver.navigate().back()')
    const loop = lines(new S.ScrollUntilVisible(byId, 'down', 4), kotlin, 'IOS')
    expect(loop[0]).toBe('for (i in 0 until 4) {')
    expect(loop[1]).toBe('    if (driver.findElements(By.id("login")).any { it.isDisplayed }) break')
    expect(loop[loop.length - 1]).toBe('}')
    expect(one(new S.Swipe('up'), kotlin).includes('driver.manage().window().size.width')).toBe(true)
  })

  // ---- Python

  it('python steps', () => {
    expect(one(new S.Tap(byId), python)).toBe('driver.find_element(AppiumBy.ID, "login").click()')
    expect(lines(new S.Fill(byId, 'x'), python)).toEqual(['driver.find_element(AppiumBy.ID, "login").clear()', 'driver.find_element(AppiumBy.ID, "login").send_keys("x")'])
    expect(one(new S.DoubleTap(byId), python)).toBe('driver.execute_script("mobile: doubleClickGesture", {"elementId": driver.find_element(AppiumBy.ID, "login").id})')
    expect(one(new S.Expect(byId, new Assertion.HasText('Hi')), python)).toBe('assert wait.until(EC.visibility_of_element_located((AppiumBy.ID, "login"))).text == "Hi"')
    expect(one(new S.Expect(byId, new Assertion.ContainsText('Hi')), python)).toBe('assert "Hi" in wait.until(EC.visibility_of_element_located((AppiumBy.ID, "login"))).text')
    expect(one(new S.Expect(byId, new Assertion.Enabled(false)), python)).toBe('assert not wait.until(EC.visibility_of_element_located((AppiumBy.ID, "login"))).is_enabled()')
    expect(one(new S.WaitFor(byId, WaitState.HIDDEN), python)).toBe('wait.until(EC.invisibility_of_element_located((AppiumBy.ID, "login")))')
    expect(one(new S.WaitFor(byId, WaitState.ENABLED), python)).toBe('wait.until(lambda d: d.find_element(AppiumBy.ID, "login").is_enabled())')
    expect(one(S.GoBack, python)).toBe('driver.back()')
    const loop = lines(new S.ScrollUntilVisible(byId, 'up', 3), python, 'IOS')
    expect(loop).toEqual([
      'for _ in range(3):',
      '    if any(e.is_displayed() for e in driver.find_elements(AppiumBy.ID, "login")): break',
      '    driver.execute_script("mobile: swipe", {"direction": "up"})',
    ])
    expect(one(new S.Swipe('up'), python).includes('driver.get_window_size()["width"]')).toBe(true)
  })

  // ---- C#

  it('csharp steps', () => {
    expect(one(new S.Tap(byId), csharp)).toBe('driver.FindElement(By.Id("login")).Click();')
    expect(lines(new S.Fill(byAcc, 'x'), csharp)).toEqual(['driver.FindElement(MobileBy.AccessibilityId("login")).Clear();', 'driver.FindElement(MobileBy.AccessibilityId("login")).SendKeys("x");'])
    expect(one(new S.LongPress(byId, 700), csharp)).toBe(
      'driver.ExecuteScript("mobile: longClickGesture", new Dictionary<string, object> { { "elementId", ((WebElement)driver.FindElement(By.Id("login"))).Id }, { "duration", 700 } });',
    )
    expect(one(new S.Expect(byId, new Assertion.HasText('Hi')), csharp)).toBe('Assert.That(wait.Until(d => d.FindElements(By.Id("login")).FirstOrDefault(e => e.Displayed)).Text, Is.EqualTo("Hi"));')
    expect(one(new S.Expect(byId, new Assertion.ContainsText('Hi')), csharp)).toBe('Assert.That(wait.Until(d => d.FindElements(By.Id("login")).FirstOrDefault(e => e.Displayed)).Text, Does.Contain("Hi"));')
    expect(one(new S.WaitFor(byId, WaitState.HIDDEN), csharp)).toBe('wait.Until(d => !d.FindElements(By.Id("login")).Any(e => e.Displayed));')
    expect(one(new S.WaitFor(byId, WaitState.DISABLED), csharp)).toBe('wait.Until(d => d.FindElements(By.Id("login")).Any(e => !e.Enabled));')
    expect(one(S.GoBack, csharp)).toBe('driver.Navigate().Back();')
    expect(one(new S.Swipe('up'), csharp).includes('driver.Manage().Window.Size.Width')).toBe(true)
    expect(lines(new S.ScrollUntilVisible(byId, 'up', 2), csharp)[0]).toBe('for (var i = 0; i < 2 && !driver.FindElements(By.Id("login")).Any(e => e.Displayed); i++) {')
  })

  // ---- whole script

  it('render adds the wait declaration and the assert import only when used', () => {
    const tapOnly = AppiumSteps.render([new S.Tap(byId)], java, 'ANDROID')
    expect(tapOnly).toBe('driver.findElement(By.id("login")).click();')
    const full = AppiumSteps.render([new S.Tap(byId), new S.Expect(byId, new Assertion.HasText('Hi'))], java, 'ANDROID').split(/\r?\n/)
    expect(full[0]).toBe('// WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(10));')
    expect(full[1]).toBe('// import static org.junit.jupiter.api.Assertions.*;')
    expect(full.length).toBe(4)
    const cs = AppiumSteps.render([new S.WaitFor(byId, WaitState.HIDDEN)], csharp, 'IOS').split(/\r?\n/)
    expect(cs.slice(0, 2)).toEqual(['// var wait = new WebDriverWait(driver, TimeSpan.FromSeconds(10));', '// using System.Linq;'])
    const csVisible = AppiumSteps.render([new S.Expect(byId, Assertion.Visible)], csharp, 'IOS')
    expect(csVisible.includes('FirstOrDefault(') && csVisible.includes('// using System.Linq;')).toBe(true)
    const py = AppiumSteps.render([new S.Expect(byId, Assertion.Visible)], python, 'IOS')
    expect(py.startsWith('# wait = WebDriverWait(driver, 10)')).toBe(true)
  })

  it('mobilewright output is the plain code and the summary joins lines', () => {
    const steps = [new S.Tap(byId)]
    expect(RecorderOutput.MOBILEWRIGHT.render(steps, 'ANDROID')).toBe("await screen.getByTestId('login').tap();")
    expect(RecorderOutput.APPIUM_JAVA.summary(new S.Fill(byId, 'x'), 'ANDROID')).toBe('driver.findElement(By.id("login")).clear(); driver.findElement(By.id("login")).sendKeys("x");')
    expect(RecorderOutput.fromName('nonsense')).toBe(RecorderOutput.MOBILEWRIGHT)
    expect(RecorderOutput.fromName('APPIUM_PYTHON')).toBe(RecorderOutput.APPIUM_PYTHON)
  })

  // ---- recorder integration

  const ios = WdaSourceParser.parse(fixture('ios_login.xml'))

  it('the recorder computes the appium locator at record time', () => {
    const r = new ScriptRecorder('IOS')
    r.tap(ios, 100, 220)
    r.type('hi')
    expect(r.steps.length).toBe(1)
    const fill = r.steps[0] as ScriptRecorder.Fill
    expect(fill).toBeInstanceOf(S.Fill)
    expect(fill.target.appium).toBeInstanceOf(PageLocator.Appium)
    const out = AppiumSteps.lines(fill, java, 'IOS')
    expect(out.length).toBe(2)
    expect(out[1].endsWith('.sendKeys("hi");'), out.toString()).toBe(true)
  })
})
