// ported-from: test:core/LocatorExtractionTest.kt
import { describe, expect, it } from 'vitest'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { LocatorExtraction } from '../../src/core/inspector/locatorExtraction'
import { ShowLocator, ShowLocatorResult } from '../../src/core/inspector/showLocator'
import type { UiNode } from '../../src/core/inspector/uiNode'
import { fixture } from '../helpers/fixtures'

const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))
const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

const ex = (text: string) => LocatorExtraction.extract(text)?.expression
const substringAfter = (s: string, d: string) => (s.includes(d) ? s.slice(s.indexOf(d) + d.length) : s)
const removeSuffix = (s: string, x: string) => (s.endsWith(x) ? s.slice(0, s.length - x.length) : s)

describe('LocatorExtractionTest', () => {
  it('mobilewrightLineWithAction', () => {
    expect(ex('  await screen.getByTestId("a").tap();')).toBe('screen.getByTestId("a")')
    expect(ex("await device.screen.getByText('Sign In').tap()")).toBe("screen.getByText('Sign In')")
  })

  it('mobilewrightChainAndNth', () => {
    expect(ex("await screen.getByTestId('card').getByText('Buy').nth(1).tap()")).toBe("screen.getByTestId('card').getByText('Buy').nth(1)")
    expect(ex('await expect(screen.getByLabel("x").first()).toBeVisible()')).toBe('screen.getByLabel("x").first()')
  })

  it('mobilewrightWithoutScreenPrefix', () => {
    expect(ex("await getByRole('button', { name: 'Go (now)' }).tap()")).toBe("screen.getByRole('button', { name: 'Go (now)' })")
  })

  it('javaAndKotlin', () => {
    expect(ex('driver.findElement(By.id("x")).click();')).toBe('findElement(By.id("x"))')
    expect(ex('val by = By.id("x")')).toBe('By.id("x")')
    expect(removeSuffix(substringAfter(ex('driver.findElement(AppiumBy.accessibilityId("y")).sendKeys("a (b)")')!, 'findElement('), ')')).toBe('AppiumBy.accessibilityId("y")')
    expect(removeSuffix(substringAfter(ex('WebElement e = driver.findElement(By.xpath("//a[@x=\'1\']"));')!, 'findElement('), ')')).toBe('By.xpath("//a[@x=\'1\']")')
  })

  it('python', () => {
    expect(ex('el = self.driver.find_element(AppiumBy.ACCESSIBILITY_ID, "y").click()')).toBe('find_element(AppiumBy.ACCESSIBILITY_ID, "y")')
    expect(ex('driver.find_element(by=AppiumBy.ID, value="x")')).toBe('find_element(by=AppiumBy.ID, value="x")')
    expect(ex('LOGIN = (AppiumBy.ID, "x")')).toBe('AppiumBy.ID, "x"')
    expect(ex('driver.find_element("xpath", \'//a[@b="c"]\').tap()')).toBe('xpath=//a[@b="c"]')
  })

  it('csharp', () => {
    expect(removeSuffix(substringAfter(ex('driver.FindElement(MobileBy.AccessibilityId("y")).Click();')!, 'FindElement('), ')')).toBe('MobileBy.AccessibilityId("y")')
  })

  it('prefixedStrings', () => {
    expect(ex('locator = "id=com.x:id/y"')).toBe('id=com.x:id/y')
    expect(ex('const l = \'xpath=//Button[@name="b"]\';')).toBe('xpath=//Button[@name="b"]')
    expect(ex('val s = "accessibility id=Login"')).toBe('accessibility id=Login')
    expect(ex('foo(id="abc")')).toBe('id=abc')
  })

  it('quotedXPathAndBareSelection', () => {
    expect(ex('val xp = "//XCUIElementTypeButton[@name=\'x\']"')).toBe("//XCUIElementTypeButton[@name='x']")
    expect(ex("x = '(//a)[2]'")).toBe('(//a)[2]')
    expect(ex("//a[@b='c']")).toBe("//a[@b='c']")
  })

  it('multilineSelection', () => {
    expect(ex("screen\n  .getByTestId('a')\n  .getByText('b')\n  .tap()")).toBe("screen.getByTestId('a').getByText('b')")
  })

  it('nothingFound', () => {
    expect(ex('')).toBeUndefined()
    expect(ex('   ')).toBeUndefined()
    expect(ex('val x = 5 + 3')).toBeUndefined()
    expect(ex('println("hello world")')).toBeUndefined()
  })

  it('textInsideMobilewrightStringDoesNotTriggerAppium', () => {
    expect(ex('await screen.getByText("By.id").tap()')).toBe('screen.getByText("By.id")')
  })

  // ---- evaluation

  it('evaluatesAndNames', () => {
    const r = ShowLocator.evaluate('await screen.getByTestId("email-input").tap()', ios)
    expect(r).toBeInstanceOf(ShowLocatorResult.Matches)
    expect(r.message()).toBe('1 match (unique): screen.getByTestId("email-input")')
    expect(r.isSuccess).toBe(true)
  })

  it('noMatchAndSeveral', () => {
    expect(ShowLocator.evaluate('screen.getByTestId("nope-nope").tap()', ios).message().startsWith('no match')).toBe(true)
    const many = ShowLocator.evaluate('driver.findElements(By.xpath("//*"))', android)
    expect(many.message().includes(' matches: '), many.message()).toBe(true)
  })

  it('androidIdFromJava', () => {
    const r = ShowLocator.evaluate('driver.findElement(By.id("com.example.app:id/email")).click();', android)
    expect((r as ShowLocatorResult.Matches).nodes.length).toBe(1)
  })

  it('notSupportedAndNoLocator', () => {
    const r = ShowLocator.evaluate('driver.findElement(By.name("x")).click()', android)
    expect(r.message().startsWith('not supported: '), r.message()).toBe(true)
    expect(ShowLocator.evaluate('val a = 1', android).message()).toBe('no locator found in the selection or on this line')
    expect(ShowLocatorResult.NoDevice.message()).toBe('no device connected: connect one in Mobile Devices')
  })
})
