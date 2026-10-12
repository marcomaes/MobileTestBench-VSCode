// ported-from: test:core/AppiumLocatorQueryTest.kt
// The code-form half of `every appium locator the generator shows finds exactly its own element` needs PageObjectGenerator
// (outside this scope) and is skipped; the bare form half is ported under the same name.
import { describe, expect, it } from 'vitest'
import { AppiumBy, AppiumLocatorQuery } from '../../src/core/inspector/appiumLocatorQuery'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { IllegalArgumentException } from '../../src/core/inspector/illegalArgumentException'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { LocatorGenerator } from '../../src/core/inspector/locators'
import { UiNode } from '../../src/core/inspector/uiNode'
import { fixture } from '../helpers/fixtures'

const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))
const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

const count = (expr: string, root: UiNode) => LocatorQuery.find(expr, root).length

function refused(expr: string, root: UiNode, contains: string) {
  let found: UiNode[]
  try {
    found = LocatorQuery.find(expr, root)
  } catch (e) {
    expect(e).toBeInstanceOf(IllegalArgumentException)
    expect((e as Error).message, `'${(e as Error).message}' should contain '${contains}'`).toContain(contains)
    return
  }
  throw new Error(`expected a refusal for ${expr} but found ${found.length}`)
}

describe('AppiumLocatorQueryTest', () => {
  // ---- parsing the forms

  it('bare strategy forms', () => {
    expect(AppiumLocatorQuery.parse('id=com.x:id/y')).toEqual({ by: AppiumBy.ID, value: 'com.x:id/y' })
    expect(AppiumLocatorQuery.parse('accessibility id=Login')).toEqual({ by: AppiumBy.ACCESSIBILITY_ID, value: 'Login' })
    expect(AppiumLocatorQuery.parse('accessibility id = "Login"')).toEqual({ by: AppiumBy.ACCESSIBILITY_ID, value: 'Login' })
    expect(AppiumLocatorQuery.parse('-android uiautomator=new UiSelector().text("a")').by).toBe(AppiumBy.ANDROID_UIAUTOMATOR)
    expect(AppiumLocatorQuery.parse('-ios predicate string=type == "X" AND name == "x"').value).toBe('type == "X" AND name == "x"')
    expect(AppiumLocatorQuery.parse('-ios class chain=**/XCUIElementTypeButton').by).toBe(AppiumBy.IOS_CLASS_CHAIN)
    expect(AppiumLocatorQuery.parse("xpath=//a[@b='c']")).toEqual({ by: AppiumBy.XPATH, value: "//a[@b='c']" })
  })

  it('java and kotlin forms', () => {
    expect(AppiumLocatorQuery.parse('By.id("x")')).toEqual({ by: AppiumBy.ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('AppiumBy.accessibilityId("x");')).toEqual({ by: AppiumBy.ACCESSIBILITY_ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('AppiumBy.androidUIAutomator("new UiSelector().text(\\"a\\")")')).toEqual({ by: AppiumBy.ANDROID_UIAUTOMATOR, value: 'new UiSelector().text("a")' })
    expect(AppiumLocatorQuery.parse('AppiumBy.iOSNsPredicateString("name == \'a\'")').by).toBe(AppiumBy.IOS_PREDICATE)
    expect(AppiumLocatorQuery.parse('AppiumBy.iOSClassChain("**/XCUIElementTypeButton")').by).toBe(AppiumBy.IOS_CLASS_CHAIN)
    expect(AppiumLocatorQuery.parse('driver.findElement(By.xpath("//a"))')).toEqual({ by: AppiumBy.XPATH, value: '//a' })
    expect(AppiumLocatorQuery.parse('val e = driver.findElements(By.id("x"))')).toEqual({ by: AppiumBy.ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('By.className("android.widget.Button")')).toEqual({ by: AppiumBy.CLASS_NAME, value: 'android.widget.Button' })
  })

  it('python forms', () => {
    expect(AppiumLocatorQuery.parse('(AppiumBy.ID, "x")')).toEqual({ by: AppiumBy.ID, value: 'x' })
    expect(AppiumLocatorQuery.parse("driver.find_element(AppiumBy.ACCESSIBILITY_ID, 'x')")).toEqual({ by: AppiumBy.ACCESSIBILITY_ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('driver.find_elements(by=AppiumBy.IOS_CLASS_CHAIN, value="**/A")')).toEqual({ by: AppiumBy.IOS_CLASS_CHAIN, value: '**/A' })
    expect(AppiumLocatorQuery.parse('(AppiumBy.IOS_PREDICATE, "name == \'a\'")')).toEqual({ by: AppiumBy.IOS_PREDICATE, value: "name == 'a'" })
    expect(AppiumLocatorQuery.parse('(By.XPATH, r"//a\\b")')).toEqual({ by: AppiumBy.XPATH, value: '//a\\b' })
    expect(AppiumLocatorQuery.parse("(AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text(\"a\")')")).toEqual({ by: AppiumBy.ANDROID_UIAUTOMATOR, value: 'new UiSelector().text("a")' })
  })

  it('csharp forms', () => {
    expect(AppiumLocatorQuery.parse('By.Id("x")')).toEqual({ by: AppiumBy.ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('driver.FindElement(MobileBy.AccessibilityId("x"));')).toEqual({ by: AppiumBy.ACCESSIBILITY_ID, value: 'x' })
    expect(AppiumLocatorQuery.parse('MobileBy.IosNSPredicate("name == \'a\'")').by).toBe(AppiumBy.IOS_PREDICATE)
    expect(AppiumLocatorQuery.parse('MobileBy.IosClassChain("**/A")').by).toBe(AppiumBy.IOS_CLASS_CHAIN)
    expect(AppiumLocatorQuery.parse('MobileBy.AndroidUIAutomator("new UiSelector()")').by).toBe(AppiumBy.ANDROID_UIAUTOMATOR)
    expect(AppiumLocatorQuery.parse('By.XPath(@"//a[@b=""c""]")')).toEqual({ by: AppiumBy.XPATH, value: '//a[@b="c"]' })
    expect(AppiumLocatorQuery.parse('AppiumBy.AccessibilityId("x")').by).toBe(AppiumBy.ACCESSIBILITY_ID)
  })

  it('detection keeps xpath and mobilewright apart', () => {
    expect(AppiumLocatorQuery.looksLikeAppium('(AppiumBy.ID, "x")')).toBe(true)
    expect(!AppiumLocatorQuery.looksLikeAppium('(//a[@text="By.id(x)"])[1]')).toBe(true)
    expect(!AppiumLocatorQuery.looksLikeAppium("//a[@text='By.id']")).toBe(true)
    expect(!AppiumLocatorQuery.looksLikeAppium('screen.getByText(\'By.id("x")\')')).toBe(true)
    expect(!AppiumLocatorQuery.looksLikeAppium("screen.getByTestId('x')")).toBe(true)
    expect(count('(//android.widget.Button)[1]', android)).toBe(1)
  })

  it('refusals are precise', () => {
    refused('By.name("x")', android, 'not supported yet: By.name')
    refused('By.cssSelector("x")', android, 'not supported yet')
    refused('By.id("a" + b)', android, 'not supported yet: + b')
    refused('driver.findElement(By.id("a")).click()', android, 'not supported yet: .click()')
    refused('driver.find_element("id", "x")', android, 'not supported yet')
    refused('By.id($"x")', android, 'interpolated')
    refused('By.id("x"', android, '')
    refused('id=', android, 'needs a value')
  })

  // ---- id and accessibility id

  it('id and accessibility id on android', () => {
    expect(count('id=com.example.app:id/email', android)).toBe(1)
    expect(count('id=email', android)).toBe(0)
    expect(count('id=com.example.app:id/', android)).toBe(0)
    expect(count('accessibility id=Email', android)).toBe(1)
    expect(count('accessibility id=Sign In', android)).toBe(0)
    expect(count('By.id("com.example.app:id/email")', android)).toBe(1)
    expect(count('By.className("android.widget.Button")', android)).toBe(2)
  })

  it('id and accessibility id on ios use name', () => {
    expect(count('id=email-input', ios)).toBe(1)
    expect(count('AppiumBy.accessibilityId("email-input")', ios)).toBe(1)
    expect(count('accessibility id=Email', ios)).toBe(0)
    expect(count('accessibility id=Sign In', ios)).toBe(1)
    expect(count('class name=XCUIElementTypeButton', ios)).toBe(2)
  })

  it('xpath code form', () => {
    expect(count('driver.findElement(By.xpath("//android.widget.EditText"))', android)).toBe(1)
    expect(count('xpath=/hierarchy/android.widget.FrameLayout[1]/android.widget.LinearLayout[1]/android.widget.EditText[1]', android)).toBe(1)
  })

  // ---- UiSelector

  it('uiselector text and description', () => {
    const ui = (chain: string) => count(`-android uiautomator=new UiSelector()${chain}`, android)
    expect(ui('.text("Sign In")')).toBe(2)
    expect(ui('.textContains("Sign")')).toBe(2)
    expect(ui('.textStartsWith("Si")')).toBe(2)
    expect(ui('.textMatches("Sign.*")')).toBe(2)
    expect(ui('.textMatches("Sign")')).toBe(0)
    expect(ui('.description("Email")')).toBe(1)
    expect(ui('.descriptionContains("mail")')).toBe(1)
    expect(ui('.descriptionStartsWith("Em")')).toBe(1)
    expect(ui('.descriptionMatches("E.*l")')).toBe(1)
    expect(ui('.resourceId("com.example.app:id/email")')).toBe(1)
    expect(ui('.resourceIdMatches(".*:id/em.*")')).toBe(1)
    expect(ui('.className("android.widget.Button")')).toBe(2)
    expect(ui('.classNameMatches(".*Button")')).toBe(2)
    expect(ui('.packageName("com.example.app")')).toBe(6)
  })

  it('uiselector flags index and instance', () => {
    const ui = (chain: string) => LocatorQuery.find(`-android uiautomator=new UiSelector()${chain}`, android)
    expect(ui('.clickable(true)').length).toBe(3)
    expect(ui('.clickable(true).className("android.widget.EditText")').length).toBe(1)
    expect(ui('.clickable(false)').length).toBe(3)
    expect(ui('.focusable(true).clickable(true).enabled(true).selected(false).checked(false).focused(false)').length).toBe(3)
    const second = ui('.className("android.widget.Button").instance(1)')
    expect(second.length).toBe(1)
    expect(second[0]).toBe([...android.walk()].filter((it) => it.rawType === 'android.widget.Button')[1])
    expect(ui('.className("android.widget.Button").instance(5)')).toEqual([])
    expect(ui('.index(0)').find((it) => it.rawType.endsWith('TextView'))!.attr('text')).toBe('Welcome')
    expect(ui('.className("android.widget.Button").index(3)').length).toBe(1)
  })

  it('uiselector child selector finds descendants', () => {
    const found = LocatorQuery.find('-android uiautomator=new UiSelector().className("android.widget.LinearLayout").childSelector(new UiSelector().text("Sign In").instance(1))', android)
    expect(found.length).toBe(1)
    expect(found[0]).toBe([...android.walk()].filter((it) => it.attr('text') === 'Sign In')[1])
    expect(count('-android uiautomator=new UiSelector().className("android.widget.FrameLayout").childSelector(new UiSelector().text("Sign In"))', android)).toBe(2)
    expect(count('-android uiautomator=new UiSelector().text("Welcome").childSelector(new UiSelector().text("x"))', android)).toBe(0)
  })

  it('uiselector refusals', () => {
    const ui = (chain: string) => `-android uiautomator=new UiSelector()${chain}`
    refused(ui('.fromParent(new UiSelector().text("a"))'), android, 'fromParent')
    refused(ui('.bogus("a")'), android, 'not supported yet: UiSelector.bogus')
    refused('-android uiautomator=new UiScrollable(new UiSelector().scrollable(true))', android, 'UiScrollable')
    refused(ui('.text("a") extra'), android, 'not supported yet')
    refused(ui('.instance(x)'), android, 'takes a number')
    refused(ui('.clickable(maybe)'), android, 'true or false')
    refused(ui('.textMatches("[")'), android, 'Invalid regex')
    refused(ui('.text("a")'), ios, 'needs an Android screen')
  })

  it('uiselector refuses string methods UiSelector does not have', () => {
    const ui = (chain: string) => `-android uiautomator=new UiSelector()${chain}`
    for (const m of ['resourceIdContains', 'resourceIdStartsWith', 'classNameContains', 'classNameStartsWith', 'packageNameContains', 'packageNameStartsWith']) {
      refused(ui(`.${m}("a")`), android, `not supported yet: UiSelector.${m}`)
    }
    expect(count(ui('.resourceIdMatches(".*email")'), android)).toBe(1)
  })

  it('attributes missing from the whole hierarchy are refused not counted', () => {
    const a = new UiNode('ANDROID', 'hierarchy', {}, undefined)
    a.addChild(new UiNode('ANDROID', 'android.widget.Button', { text: 'x', enabled: 'true' }, undefined))
    refused('-android uiautomator=new UiSelector().scrollable(true)', a, "'scrollable' is not in this hierarchy dump")
    refused('-android uiautomator=new UiSelector().focusable(false)', a, 'not in this hierarchy dump')
    refused('-android uiautomator=new UiSelector().packageName("p")', a, "'package' is not in this hierarchy dump")
    refused('-android uiautomator=new UiSelector().text("x").childSelector(new UiSelector().longClickable(true))', a, "'long-clickable'")
    expect(count('-android uiautomator=new UiSelector().enabled(true)', a)).toBe(1)

    const i = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    i.addChild(new UiNode('IOS', 'XCUIElementTypeButton', { name: 'x', enabled: 'true', visible: 'true' }, undefined))
    refused('-ios predicate string=accessible == true', i, "'accessible' is not in this hierarchy dump")
    refused("-ios predicate string=name == 'x' AND NOT (accessible == false)", i, 'not in this hierarchy dump')
    expect(count('-ios predicate string=visible == true', i)).toBe(1)
  })

  it('uiselector code form with escaped quotes', () => {
    expect(count('AppiumBy.androidUIAutomator("new UiSelector().text(\\"Sign In\\")")', android)).toBe(2)
    expect(count("driver.find_elements(AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text(\"Sign In\")')", android)).toBe(2)
  })

  // ---- iOS predicate

  const pred = (p: string) => LocatorQuery.find(`-ios predicate string=${p}`, ios)

  it('predicate comparisons', () => {
    expect(pred('type == "XCUIElementTypeButton"').length).toBe(2)
    expect(pred("type == 'XCUIElementTypeButton' AND name == 'Sign In'").length).toBe(1)
    expect(pred("name = 'Sign In' && visible == true && type = 'XCUIElementTypeButton'").length).toBe(1)
    expect(pred("type == 'XCUIElementTypeButton' OR name == 'Welcome'").length).toBe(3)
    expect(pred("NOT (type == 'XCUIElementTypeButton')").length).toBe(3)
    expect(pred("label CONTAINS 'mai'").length).toBe(1)
    expect(pred("label CONTAINS 'MAI'").length).toBe(0)
    expect(pred("label CONTAINS[c] 'MAI'").length).toBe(1)
    expect(pred("label BEGINSWITH 'Em'").length).toBe(1)
    expect(pred("label ENDSWITH 'ail'").length).toBe(1)
    expect(pred("name LIKE 'S*' AND type == 'XCUIElementTypeButton'").length).toBe(1)
    expect(pred("name LIKE 'Welc?me'").length).toBe(1)
    expect(pred("name MATCHES 'email-.*'").length).toBe(1)
    expect(pred("name MATCHES 'email'").length).toBe(0)
    expect(pred("name IN {'Welcome', 'email-input'}").length).toBe(2)
    expect(pred("identifier == 'email-input'").length).toBe(1)
    expect(pred("name != 'Welcome' AND type CONTAINS 'XCUIElementTypeB' OR type == 'XCUIElementTypeTextField'").length).toBe(3)
    expect(pred('visible == false').length).toBe(1)
    expect(pred('visible == 0').length).toBe(1)
    expect(pred('enabled == YES').length).toBe(5)
    expect(pred("(name == 'Hidden' OR name == 'Welcome') AND visible == true").length).toBe(1)
  })

  it('predicate not-equal includes elements without the attribute', () => {
    // The window has no name: NSPredicate treats nil != 'x' as true.
    expect(pred("name != 'Welcome'").length).toBe(4)
  })

  it('predicate refusals', () => {
    refused('-ios predicate string=hittable == true', ios, "predicate field 'hittable'")
    refused("-ios predicate string=name > 'a'", ios, 'operator >')
    refused('-ios predicate string=value == 5', ios, 'not supported yet: 5')
    refused("-ios predicate string=enabled CONTAINS 'a'", ios, 'boolean')
    refused('-ios predicate string=name == %@', ios, "'%'")
    refused('-ios predicate string=SUBQUERY(a, $x, true)', ios, 'not supported yet')
    refused("-ios predicate string=name == 'a' AND", ios, '')
    refused("-ios predicate string=(name == 'a'", ios, 'closing parenthesis')
    refused("-ios predicate string=name MATCHES '['", ios, 'Invalid regex')
    refused("-ios predicate string=name ==[x] 'a'", ios, 'modifier')
    refused("-ios predicate string=name == 'a'", android, 'needs an iOS screen')
  })

  // ---- class chain

  const chain = (c: string) => LocatorQuery.find(`-ios class chain=${c}`, ios)

  it('class chain forms', () => {
    expect(chain('**/XCUIElementTypeButton').length).toBe(2)
    expect(chain('**/XCUIElementTypeButton[`name == "Sign In"`]').length).toBe(1)
    expect(chain("**/XCUIElementTypeButton[`name == 'Sign In'`]").length).toBe(1)
    expect(chain('XCUIElementTypeWindow/XCUIElementTypeButton').length).toBe(2)
    expect(chain('XCUIElementTypeButton').length).toBe(0)
    expect(chain('XCUIElementTypeWindow/*').length).toBe(4)
    expect(chain('**/XCUIElementTypeButton[2]')[0].attr('name')).toBe('Hidden')
    expect(chain('**/XCUIElementTypeButton[2]').length).toBe(1)
    expect(chain('**/XCUIElementTypeButton[-1]')[0].attr('name')).toBe('Hidden')
    expect(chain('XCUIElementTypeWindow/XCUIElementTypeButton[1]')[0].attr('name')).toBe('Sign In')
    expect(chain('**/XCUIElementTypeButton[`visible == true`][1]')[0].attr('name')).toBe('Sign In')
    expect(chain('**/XCUIElementTypeButton[3]').length).toBe(0)
    expect(chain("**/XCUIElementTypeWindow/XCUIElementTypeTextField[`label == 'Email' AND name == 'email-input'`]").length).toBe(1)
    expect(chain("**/XCUIElementTypeButton[`name == 'a/b' OR name == 'Hidden'`]").length).toBe(1)
    expect(chain('**/*').length).toBe(5)
  })

  it('class chain refusals', () => {
    refused("-ios class chain=**/XCUIElementTypeCell[$name == 'x'$]", ios, 'not supported yet')
    refused('-ios class chain=**/XCUIElementTypeButton[0]', ios, 'not supported yet')
    refused('-ios class chain=**', ios, 'cannot end with **')
    refused('-ios class chain=**/Button', ios, 'Unknown element type')
    refused('-ios class chain=**//XCUIElementTypeButton', ios, 'Empty segment')
    refused("-ios class chain=**/XCUIElementTypeButton[`name == 'x'", ios, 'Unbalanced backtick')
    refused('-ios class chain=**/XCUIElementTypeButton[1', ios, 'Missing ]')
    refused('-ios class chain=**/XCUIElementTypeButton', android, 'needs an iOS screen')
  })

  // ---- consistency with the generator

  it('every appium locator the generator shows finds exactly its own element', () => {
    let checked = 0
    for (const root of [android, ios]) {
      for (const node of [...root.walk()].filter((it) => !it.isRoot && Object.keys(it.attributes).length > 0)) {
        const suggestions = LocatorGenerator.suggest(node, root).filter((it) => it.framework === 'Appium')
        for (const s of suggestions) {
          // The bare form, as shown in the table (xpath (absolute) / xpath (in parent) are the xpath strategy).
          const label = s.strategy.startsWith('xpath') ? 'xpath' : s.strategy
          const bare = `${AppiumBy.entries.find((it) => it.label === label)!.label}=${s.expression}`
          const found = LocatorQuery.find(bare, root)
          expect(found.length, `${bare} matchCount`).toBe(s.matchCount)
          if (s.isUnique) expect(found[0], bare).toBe(node)
          checked++
        }
      }
    }
    expect(checked, `checked ${checked}`).toBeGreaterThan(30)
  })
})
