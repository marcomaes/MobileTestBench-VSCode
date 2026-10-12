// ported-from: test:core/PageObjectTest.kt
import { describe, expect, it } from 'vitest'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect } from '../../src/core/model'
import {
  AppiumStrategy,
  LocatorStyle,
  PageElement,
  PageLocator,
  PageObjectCandidates,
  PageObjectGenerator,
  PageObjectLanguage,
  type PageAction,
} from '../../src/core/pageobject/pageObject'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))
const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))

const actions = (...a: PageAction[]): Set<PageAction> => new Set(a)

describe('PageObjectTest', () => {
  // ---- candidates

  it('candidates are the visible elements with a unique locator, controls ticked first', () => {
    const candidates = PageObjectCandidates.find(ios, false)
    const email = candidates.find((it) => it.node.identifier === 'email-input')!
    expect(email.suggestedName.toLowerCase()).toBe('email input field')
    expect(email.actions).toEqual(actions('FILL', 'READ'))
    expect(email.locator).toEqual(new PageLocator.Mobilewright("screen.getByTestId('email-input')"))
    expect(email.selectedByDefault).toBe(true)
    const signIn = candidates.find((it) => it.node.label === 'Sign In' && it.node.type === 'Button')!
    expect(signIn.actions).toEqual(actions('TAP'))
    expect(candidates.every((it) => it.node.attr('name') !== 'Hidden')).toBe(true) // not visible
  })

  it('plain texts are offered but not ticked', () => {
    const text = PageObjectCandidates.find(ios, false).find((it) => it.node.type === 'StaticText')!
    expect(text.actions).toEqual(actions('READ'))
    expect(text.selectedByDefault).toBe(false)
  })

  it('appium locators prefer an id, then an accessibility id, and are unique', () => {
    const a = PageObjectCandidates.find(android, true).find((it) => it.node.resourceId === 'com.example.app:id/email')!
    expect(a.locator).toEqual(new PageLocator.Appium(AppiumStrategy.ID, 'com.example.app:id/email'))
    const i = PageObjectCandidates.find(ios, true).find((it) => it.node.identifier === 'email-input')!
    expect(i.locator).toEqual(new PageLocator.Appium(AppiumStrategy.ACCESSIBILITY_ID, 'email-input'))
  })

  it('names are unique within a page and keep to words', () => {
    const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    for (const i of ['a', 'b']) {
      root.addChild(new UiNode('IOS', 'XCUIElementTypeButton', { name: `OK-${i}`, label: 'Same', visible: 'true' }, rect(0, 0, 50, 50)))
    }
    // Two buttons with the same label: no unique label locator, but the names must not collide.
    const names = PageObjectCandidates.find(root, false).map((it) => it.suggestedName)
    expect(new Set(names.map((it) => it.toLowerCase())).size).toBe(names.length)
  })

  it('an element without a unique locator is offered without one', () => {
    const root = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    for (let i = 0; i < 2; i++) root.addChild(new UiNode('IOS', 'XCUIElementTypeButton', { name: 'x', label: 'Same', visible: 'true' }, rect(0, 0, 50, 50)))
    expect(PageObjectCandidates.find(root, false).every((it) => it.locator === undefined)).toBe(true)
  })

  // ---- generator

  const mw = [
    new PageElement('email field', actions('FILL', 'READ'), new PageLocator.Mobilewright("screen.getByTestId('email-input')")),
    new PageElement('login button', actions('TAP'), new PageLocator.Mobilewright("screen.getByTestId('product-item-2').getByTestId('login')")),
    new PageElement('welcome text', actions('READ'), new PageLocator.Mobilewright("screen.getByText('Welcome')")),
  ]

  const appium = [
    new PageElement('email field', actions('FILL', 'READ'), new PageLocator.Appium(AppiumStrategy.ID, 'com.example:id/email')),
    new PageElement('login button', actions('TAP'), new PageLocator.Appium(AppiumStrategy.ACCESSIBILITY_ID, 'Log "in"')),
    new PageElement('welcome text', actions('READ'), new PageLocator.Appium(AppiumStrategy.XPATH, '//android.widget.TextView[@text="Hi"]')),
  ]

  const comment = 'Locators are private. Make one public only when a test needs it, for example in an expect or assertion.'

  const gen = (elements: PageElement[], language: PageObjectLanguage, style: LocatorStyle = LocatorStyle.BASE_CLASS_FIELDS, base = 'BasePage', sort = false) =>
    PageObjectGenerator.generate(elements, { className: 'LoginPage', language, style, baseClass: base, sortByName: sort })

  it('typescript fields use the screen of the base class and need no constructor', () => {
    expect(gen(mw, PageObjectLanguage.MOBILEWRIGHT_TS)).toBe(
      [
        "import { BasePage } from './BasePage';",
        '',
        'export class LoginPage extends BasePage {',
        `  // ${comment}`,
        "  private readonly emailField = this.screen.getByTestId('email-input');",
        "  private readonly loginButton = this.screen.getByTestId('product-item-2').getByTestId('login');",
        "  private readonly welcomeText = this.screen.getByText('Welcome');",
        '',
        '  async fillEmailField(text: string): Promise<void> {',
        '    await this.emailField.fill(text);',
        '  }',
        '',
        '  async getEmailFieldValue(): Promise<string> {',
        '    return this.emailField.getValue();',
        '  }',
        '',
        '  async tapLoginButton(): Promise<void> {',
        '    await this.loginButton.tap();',
        '  }',
        '',
        '  async getWelcomeText(): Promise<string> {',
        '    return this.welcomeText.getText();',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('typescript getters and constructor styles', () => {
    const getters = gen(mw, PageObjectLanguage.MOBILEWRIGHT_TS, LocatorStyle.GETTERS)
    expect(getters.includes('extends BasePage')).toBe(true)
    expect(getters.includes("  private get emailField() {\n    return this.screen.getByTestId('email-input');\n  }")).toBe(true)
    expect(getters.includes('constructor')).toBe(false)

    const standalone = gen(mw, PageObjectLanguage.MOBILEWRIGHT_TS, LocatorStyle.CONSTRUCTOR_FIELDS)
    expect(standalone.includes('extends') || standalone.includes('BasePage')).toBe(false)
    expect(standalone.includes("import type { Screen } from 'mobilewright';")).toBe(true)
    expect(standalone.includes("private readonly emailField: ReturnType<Screen['getByTestId']>;")).toBe(true)
    expect(standalone.includes("constructor(screen: Screen) {\n    this.emailField = screen.getByTestId('email-input');")).toBe(true)
  })

  it('javascript uses private fields', () => {
    const code = gen(mw, PageObjectLanguage.MOBILEWRIGHT_JS)
    expect(code.includes('export class LoginPage extends BasePage {')).toBe(true)
    expect(code.includes("  #emailField = this.screen.getByTestId('email-input');")).toBe(true)
    expect(code.includes('await this.#loginButton.tap();')).toBe(true)
    expect(code.includes(': Promise') || code.includes(': string') || code.includes('import type')).toBe(false)
    expect(gen(mw, PageObjectLanguage.MOBILEWRIGHT_JS, LocatorStyle.GETTERS).includes('get #emailField() {')).toBe(true)
  })

  it('the comment about private locators is in every page object exactly once', () => {
    for (const language of PageObjectLanguage.entries) {
      for (const style of LocatorStyle.entries) {
        const code = gen(language.appium ? appium : mw, language, style)
        expect(code.split(comment).length - 1, `${language} ${style}`).toBe(1)
      }
    }
  })

  it('base classes hold the screen or the driver', () => {
    const base = (language: PageObjectLanguage, name = 'BasePage') => PageObjectGenerator.generateBaseClass({ className: 'LoginPage', language, baseClass: name })
    expect(base(PageObjectLanguage.MOBILEWRIGHT_TS).includes('export abstract class BasePage {\n  constructor(protected readonly screen: Screen) {}')).toBe(true)
    expect(base(PageObjectLanguage.MOBILEWRIGHT_JS).includes('constructor(screen) {\n    this.screen = screen;')).toBe(true)
    expect(base(PageObjectLanguage.APPIUM_JAVA).includes('public abstract class BasePage {\n    protected final AppiumDriver driver;')).toBe(true)
    expect(base(PageObjectLanguage.APPIUM_JAVA).includes('protected BasePage(AppiumDriver driver) {')).toBe(true)
    expect(base(PageObjectLanguage.APPIUM_KOTLIN, 'Screens').includes('abstract class Screens(protected val driver: AppiumDriver)')).toBe(true)
    expect(base(PageObjectLanguage.APPIUM_PYTHON).includes('class BasePage:\n    def __init__(self, driver):\n        self.driver = driver')).toBe(true)
    expect(base(PageObjectLanguage.APPIUM_CSHARP).includes('protected readonly AppiumDriver Driver;')).toBe(true)
  })

  it('an own base class name is used for extends and import', () => {
    const ts = gen(mw, PageObjectLanguage.MOBILEWRIGHT_TS, undefined, 'MyScreenBase')
    expect(ts.includes("import { MyScreenBase } from './MyScreenBase';")).toBe(true)
    expect(ts.includes('export class LoginPage extends MyScreenBase {')).toBe(true)
    expect(gen(appium, PageObjectLanguage.APPIUM_JAVA, undefined, 'MyScreenBase').includes('public class LoginPage extends MyScreenBase {')).toBe(true)
    expect(gen(appium, PageObjectLanguage.APPIUM_PYTHON, undefined, 'MyScreenBase').includes('from my_screen_base import MyScreenBase\n')).toBe(true)
  })

  it('java page objects', () => {
    const fields = gen(appium, PageObjectLanguage.APPIUM_JAVA)
    expect(fields.includes('public class LoginPage extends BasePage {')).toBe(true)
    expect(fields.includes('    private final By emailField = By.id("com.example:id/email");')).toBe(true)
    expect(fields.includes('private final By loginButton = AppiumBy.accessibilityId("Log \\"in\\"");')).toBe(true)
    expect(fields.includes('    public LoginPage(AppiumDriver driver) {\n        super(driver);\n    }')).toBe(true)
    expect(fields.includes('public void tapLoginButton() {\n        driver.findElement(loginButton).click();')).toBe(true)
    expect(fields.includes('public String getEmailFieldValue() {\n        return driver.findElement(emailField).getAttribute("value");')).toBe(true)
    expect(fields.includes('public String getWelcomeText() {\n        return driver.findElement(welcomeText).getText();')).toBe(true)
    expect(fields.includes('private final AppiumDriver driver')).toBe(false)

    const getters = gen(appium, PageObjectLanguage.APPIUM_JAVA, LocatorStyle.GETTERS)
    expect(getters.includes('    private By emailField() {\n        return By.id("com.example:id/email");\n    }')).toBe(true)
    expect(getters.includes('driver.findElement(loginButton()).click();')).toBe(true)

    const standalone = gen(appium, PageObjectLanguage.APPIUM_JAVA, LocatorStyle.CONSTRUCTOR_FIELDS)
    expect(standalone.includes('public class LoginPage {')).toBe(true)
    expect(standalone.includes('    private final AppiumDriver driver;\n')).toBe(true)
    expect(standalone.includes('        this.driver = driver;\n        this.emailField = By.id("com.example:id/email");')).toBe(true)
  })

  it('kotlin page objects', () => {
    const fields = gen(appium, PageObjectLanguage.APPIUM_KOTLIN)
    expect(fields.includes('class LoginPage(driver: AppiumDriver) : BasePage(driver) {')).toBe(true)
    expect(fields.includes('    private val emailField: By = By.id("com.example:id/email")')).toBe(true)
    expect(fields.includes('fun getWelcomeText(): String =\n        driver.findElement(welcomeText).text')).toBe(true)
    expect(gen(appium, PageObjectLanguage.APPIUM_KOTLIN, LocatorStyle.GETTERS).includes('private val emailField: By get() = By.id(')).toBe(true)
    const standalone = gen(appium, PageObjectLanguage.APPIUM_KOTLIN, LocatorStyle.CONSTRUCTOR_FIELDS)
    expect(standalone.includes('class LoginPage(private val driver: AppiumDriver) {')).toBe(true)
    expect(standalone.includes('    init {\n        emailField = By.id(')).toBe(true)
    const dollar = new PageElement('price', actions('READ'), new PageLocator.Appium(AppiumStrategy.XPATH, '//x[@text="$5"]'))
    expect(gen([dollar], PageObjectLanguage.APPIUM_KOTLIN).includes('By.xpath("//x[@text=\\"\\$5\\"]")')).toBe(true)
  })

  it('python page objects', () => {
    const fields = gen(appium, PageObjectLanguage.APPIUM_PYTHON)
    expect(fields.includes('from base_page import BasePage\n')).toBe(true)
    expect(fields.includes('class LoginPage(BasePage):')).toBe(true)
    expect(fields.includes('    _EMAIL_FIELD = (AppiumBy.ID, "com.example:id/email")')).toBe(true)
    expect(fields.includes('def tap_login_button(self):\n        self.driver.find_element(*self._LOGIN_BUTTON).click()')).toBe(true)
    expect(fields.includes('__init__')).toBe(false)
    expect(gen(appium, PageObjectLanguage.APPIUM_PYTHON, LocatorStyle.GETTERS).includes('    @property\n    def _email_field(self):\n        return (AppiumBy.ID,')).toBe(true)
    const standalone = gen(appium, PageObjectLanguage.APPIUM_PYTHON, LocatorStyle.CONSTRUCTOR_FIELDS)
    expect(standalone.includes('class LoginPage:\n')).toBe(true)
    expect(standalone.includes('    def __init__(self, driver):\n        self.driver = driver\n        self._email_field = (AppiumBy.ID,')).toBe(true)
    expect(standalone.endsWith('\n') && !standalone.endsWith('\n\n')).toBe(true)
  })

  it('csharp page objects', () => {
    const fields = gen(appium, PageObjectLanguage.APPIUM_CSHARP)
    expect(fields.includes('public class LoginPage : BasePage\n{')).toBe(true)
    expect(fields.includes('    private readonly By _emailField = By.Id("com.example:id/email");')).toBe(true)
    expect(fields.includes('private readonly By _loginButton = MobileBy.AccessibilityId("Log \\"in\\"");')).toBe(true)
    expect(fields.includes('AppiumBy')).toBe(false)
    expect(fields.includes('    public LoginPage(AppiumDriver driver) : base(driver)\n    {\n    }')).toBe(true)
    expect(fields.includes('public void TapLoginButton() => Driver.FindElement(_loginButton).Click();')).toBe(true)
    expect(gen(appium, PageObjectLanguage.APPIUM_CSHARP, LocatorStyle.GETTERS).includes('    private By EmailField => By.Id("com.example:id/email");')).toBe(true)
    const standalone = gen(appium, PageObjectLanguage.APPIUM_CSHARP, LocatorStyle.CONSTRUCTOR_FIELDS)
    expect(standalone.includes('private readonly AppiumDriver _driver;')).toBe(true)
    expect(standalone.includes('_driver.FindElement(_loginButton).Click();')).toBe(true)
  })

  it('sorting by name orders the locators and the methods', () => {
    const unsorted = gen(mw, PageObjectLanguage.MOBILEWRIGHT_TS)
    expect(unsorted.indexOf('emailField =') < unsorted.indexOf('loginButton =') && unsorted.indexOf('loginButton =') < unsorted.indexOf('welcomeText =')).toBe(true)
    const shuffled = [mw[2], mw[0], mw[1]]
    const kept = gen(shuffled, PageObjectLanguage.MOBILEWRIGHT_TS)
    expect(kept.indexOf('welcomeText =') < kept.indexOf('emailField =')).toBe(true)
    const sorted = gen(shuffled, PageObjectLanguage.MOBILEWRIGHT_TS, undefined, undefined, true)
    expect(sorted.indexOf('emailField =') < sorted.indexOf('loginButton =') && sorted.indexOf('loginButton =') < sorted.indexOf('welcomeText =')).toBe(true)
    expect(sorted.indexOf('async fillEmailField') < sorted.indexOf('async tapLoginButton')).toBe(true)
  })

  it('file names follow the language', () => {
    expect(PageObjectGenerator.fileName(PageObjectLanguage.APPIUM_JAVA, 'LoginPage')).toBe('LoginPage.java')
    expect(PageObjectGenerator.fileName(PageObjectLanguage.APPIUM_PYTHON, 'LoginPage')).toBe('login_page.py')
    expect(PageObjectGenerator.fileName(PageObjectLanguage.MOBILEWRIGHT_TS, 'LoginPage')).toBe('LoginPage.ts')
  })

  it('a name that starts with a digit is still a valid identifier', () => {
    const el = new PageElement('3d view', actions('TAP'), new PageLocator.Mobilewright("screen.getByTestId('v')"))
    expect(gen([el], PageObjectLanguage.MOBILEWRIGHT_TS).includes('private readonly _3dView =')).toBe(true)
    expect(PageObjectLanguage.entries.find((it) => it.appium)).toBeDefined()
  })
})
