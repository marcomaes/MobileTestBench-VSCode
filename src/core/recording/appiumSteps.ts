// ported-from: core/recording/AppiumSteps.kt
import { requireThat } from '../inspector/illegalArgumentException'
import type { Platform } from '../model'
import { PageObjectGenerator, PageObjectLanguage, type PageLocator } from '../pageobject/pageObject'
import { WebdriverIoSteps } from './webdriverIoSteps'
import { Assertion, WaitState } from './assertion'
import { ReplayOptions } from './replayOptions'
import { ScriptRecorder } from './scriptRecorder'

type Step = ScriptRecorder.Step
type Target = ScriptRecorder.Target

/** What the Recording tab writes the steps as. Stored by [name] in the settings. */
export interface RecorderOutput {
  readonly name: string
  readonly label: string
  readonly appium: PageObjectLanguage | undefined
  readonly webdriverio: boolean
  toString(): string
  /** One step as it is shown in the list: Mobilewright code, or the Appium lines joined by a space. */
  summary(step: Step, platform: Platform): string
  /** The whole recording as code to copy or insert. */
  render(steps: readonly Step[], platform: Platform): string
}

function recorderOutput(name: string, label: string, appium: PageObjectLanguage | undefined, webdriverio = false): RecorderOutput {
  return {
    name,
    label,
    appium,
    webdriverio,
    toString: () => label,
    summary(step: Step, platform: Platform): string {
      if (webdriverio) return WebdriverIoSteps.lines(step, platform).map((it) => it.trim()).join(' ')
      if (appium === undefined) return step.code()
      return AppiumSteps.lines(step, appium, platform).map((it) => it.trim()).join(' ')
    },
    render(steps: readonly Step[], platform: Platform): string {
      if (webdriverio) return WebdriverIoSteps.render(steps, platform)
      if (appium === undefined) return steps.map((it) => it.code()).join('\n')
      return AppiumSteps.render(steps, appium, platform)
    },
  }
}

const MOBILEWRIGHT = recorderOutput('MOBILEWRIGHT', 'Mobilewright', undefined)
const entries: readonly RecorderOutput[] = [
  MOBILEWRIGHT,
  recorderOutput('APPIUM_JAVA', 'Appium Java', PageObjectLanguage.APPIUM_JAVA),
  recorderOutput('APPIUM_KOTLIN', 'Appium Kotlin', PageObjectLanguage.APPIUM_KOTLIN),
  recorderOutput('APPIUM_PYTHON', 'Appium Python', PageObjectLanguage.APPIUM_PYTHON),
  recorderOutput('APPIUM_CSHARP', 'Appium C#', PageObjectLanguage.APPIUM_CSHARP),
  recorderOutput('APPIUM_WEBDRIVERIO', 'Appium JavaScript (WebdriverIO)', undefined, true),
]

export const RecorderOutput = {
  MOBILEWRIGHT,
  APPIUM_JAVA: entries[1],
  APPIUM_KOTLIN: entries[2],
  APPIUM_PYTHON: entries[3],
  APPIUM_CSHARP: entries[4],
  APPIUM_WEBDRIVERIO: entries[5],
  entries,

  fromName(name: string | null | undefined): RecorderOutput {
    return entries.find((it) => it.name === name) ?? MOBILEWRIGHT
  },
}

const WAIT_SECONDS = 10
const SWIPE_PERCENT = '0.75'

/** Kotlin `Double.toString()` for the small values the gestures use: a whole number gets ".0". */
export function doubleToString(d: number): string {
  return Number.isInteger(d) ? `${d}.0` : String(d)
}

const removePrefix = (s: string, p: string): string => (s.startsWith(p) ? s.slice(p.length) : s)
const removeSuffix = (s: string, p: string): string => (s.endsWith(p) ? s.slice(0, s.length - p.length) : s)

/**
 * Renders recorded steps as Appium client code (Java, Kotlin, Python, C#). Pure text generation.
 *
 * Conventions: the code assumes a `driver` and, for waits and asserts, a `wait` (a `WebDriverWait` of 10 s; [render] puts the
 * declaration in a leading comment when it is needed). Elements are found with the best unique Appium locator recorded
 * with the step ([Target.appium]); a step whose element has none is written as a comment, never as coordinates.
 * Assertions: JUnit 5 (`assertEquals`, `assertTrue`) for Java and Kotlin, plain `assert` for Python, NUnit `Assert.That` for C#.
 * Gestures use the Appium `mobile:` commands of the recorded platform (UiAutomator2 `mobile: longClickGesture`,
 * `doubleClickGesture`, `swipeGesture`; XCUITest `mobile: touchAndHold`, `doubleTap`, `swipe`), because no one form works on both.
 */
export const AppiumSteps = {
  render(steps: readonly Step[], language: PageObjectLanguage, platform: Platform): string {
    const body = steps.flatMap((it) => AppiumSteps.lines(it, language, platform))
    const prefix = new Syntax(language, platform).commentPrefix
    const code = body.filter((it) => !it.trimStart().startsWith(prefix))
    return [...header(language, code), ...body].join('\n')
  },

  /** The lines of one step. A single line for most steps, a few for fill, scroll until visible and the like. */
  lines(step: Step, language: PageObjectLanguage, platform: Platform): string[] {
    requireThat(language.appium, () => `Not an Appium language: ${language}`)
    return new Syntax(language, platform).lines(step)
  },

  /** A recorder note as it reads for Appium output. */
  appiumNote(text: string): string {
    const marker = ': Mobilewright has no drag API'
    return text.includes(marker) ? text.slice(0, text.indexOf(marker)) + ': no Appium form recorded (a drag needs an element to drag)' : text
  },
}

function header(language: PageObjectLanguage, code: readonly string[]): string[] {
  const s = new Syntax(language, 'ANDROID')
  const usesWait = code.some((it) => it.includes('wait.'))
  const usesAssert = code.some((it) => s.isAssert(it))
  const usesLinq = language === PageObjectLanguage.APPIUM_CSHARP && code.some((it) => it.includes('.Any(') || it.includes('.FirstOrDefault('))
  const out: string[] = []
  if (usesWait) out.push(s.comment(s.waitDeclaration))
  if (usesAssert) out.push(s.comment(s.assertImport))
  if (usesLinq) out.push(s.comment('using System.Linq;'))
  return out
}

/** `executeScript("mobile: name", { args })`. A value of the type [Raw] is already code. */
class Raw {
  constructor(readonly code: string) {}
  toString(): string {
    return this.code
  }
}

class Syntax {
  private readonly java: boolean
  private readonly kotlin: boolean
  private readonly python: boolean
  private readonly csharp: boolean
  private readonly android: boolean

  /** The wait the waits and asserts of the current step use: the shared `wait` or, for a step with its own timeout, a new one. */
  private waiter = 'wait'

  readonly commentPrefix: string
  private readonly semi: string
  readonly waitDeclaration: string
  readonly assertImport: string

  constructor(
    readonly language: PageObjectLanguage,
    readonly platform: Platform,
  ) {
    this.java = language === PageObjectLanguage.APPIUM_JAVA
    this.kotlin = language === PageObjectLanguage.APPIUM_KOTLIN
    this.python = language === PageObjectLanguage.APPIUM_PYTHON
    this.csharp = language === PageObjectLanguage.APPIUM_CSHARP
    this.android = platform === 'ANDROID'
    this.commentPrefix = this.python ? '#' : '//'
    this.semi = this.java || this.csharp ? ';' : ''
    this.waitDeclaration = this.java
      ? `WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(${WAIT_SECONDS}));`
      : this.kotlin
        ? `val wait = WebDriverWait(driver, Duration.ofSeconds(${WAIT_SECONDS}))`
        : this.python
          ? `wait = WebDriverWait(driver, ${WAIT_SECONDS})  (from selenium.webdriver.support.ui import WebDriverWait; from selenium.webdriver.support import expected_conditions as EC)`
          : `var wait = new WebDriverWait(driver, TimeSpan.FromSeconds(${WAIT_SECONDS}));`
    this.assertImport = this.java
      ? 'import static org.junit.jupiter.api.Assertions.*;'
      : this.kotlin
        ? 'import org.junit.jupiter.api.Assertions.*'
        : this.python
          ? 'plain assert statements'
          : 'using NUnit.Framework;'
  }

  private waiterFor(timeoutMs: number | undefined): string {
    if (timeoutMs === undefined) return 'wait'
    const s = ReplayOptions.wholeSeconds(timeoutMs)
    if (this.java) return `new WebDriverWait(driver, Duration.ofSeconds(${s}))`
    if (this.kotlin) return `WebDriverWait(driver, Duration.ofSeconds(${s}))`
    if (this.python) return `WebDriverWait(driver, ${s})`
    return `new WebDriverWait(driver, TimeSpan.FromSeconds(${s}))`
  }

  comment(text: string): string {
    return `${this.commentPrefix} ${text}`
  }

  isAssert(line: string): boolean {
    if (this.python) return line.trimStart().startsWith('assert ')
    if (this.csharp) return line.includes('Assert.That(')
    return line.includes('assertEquals(') || line.includes('assertTrue(') || line.includes('assertFalse(')
  }

  // ---- literals and locators

  private str(text: string): string {
    return PageObjectGenerator.quote(text, this.kotlin)
  }

  private by(l: PageLocator.Appium): string {
    return PageObjectGenerator.appiumCode(this.language, l)!
  }

  /** Python takes the strategy and the value as two arguments: `(AppiumBy.ID, "x")` becomes `AppiumBy.ID, "x"`. */
  private args(l: PageLocator.Appium): string {
    return removeSuffix(removePrefix(this.by(l), '('), ')')
  }

  find(l: PageLocator.Appium): string {
    if (this.java || this.kotlin) return `driver.findElement(${this.by(l)})`
    if (this.python) return `driver.find_element(${this.args(l)})`
    return `driver.FindElement(${this.by(l)})`
  }

  private findAll(l: PageLocator.Appium): string {
    if (this.java || this.kotlin) return `driver.findElements(${this.by(l)})`
    if (this.python) return `driver.find_elements(${this.args(l)})`
    return `driver.FindElements(${this.by(l)})`
  }

  // ---- waits

  /** An expression that waits for the element to be visible and gives the element. */
  private visibleElement(l: PageLocator.Appium): string {
    if (this.java || this.kotlin) return `${this.waiter}.until(ExpectedConditions.visibilityOfElementLocated(${this.by(l)}))`
    if (this.python) return `${this.waiter}.until(EC.visibility_of_element_located(${this.by(l)}))`
    return `${this.waiter}.Until(d => d.FindElements(${this.by(l)}).FirstOrDefault(e => e.Displayed))`
  }

  private waitFor(l: PageLocator.Appium, state: WaitState): string {
    const w = this.waiter
    switch (state) {
      case WaitState.VISIBLE:
        return `${this.visibleElement(l)}${this.semi}`
      case WaitState.HIDDEN:
        if (this.java || this.kotlin) return `${w}.until(ExpectedConditions.invisibilityOfElementLocated(${this.by(l)}))${this.semi}`
        if (this.python) return `${w}.until(EC.invisibility_of_element_located(${this.by(l)}))`
        return `${w}.Until(d => !d.FindElements(${this.by(l)}).Any(e => e.Displayed));`
      default: {
        const enabled = state === WaitState.ENABLED
        if (this.java) return `${w}.until(d -> ${enabled ? '' : '!'}d.findElement(${this.by(l)}).isEnabled());`
        if (this.kotlin) return `${w}.until { ${enabled ? '' : '!'}it.findElement(${this.by(l)}).isEnabled }`
        if (this.python) return `${w}.until(lambda d: ${enabled ? '' : 'not '}d.find_element(${this.args(l)}).is_enabled())`
        return `${w}.Until(d => d.FindElements(${this.by(l)}).Any(e => ${enabled ? '' : '!'}e.Enabled));`
      }
    }
  }

  // ---- reading

  private text(el: string): string {
    if (this.java) return `${el}.getText()`
    if (this.kotlin || this.python) return `${el}.text`
    return `${el}.Text`
  }

  private attribute(el: string, name: string): string {
    if (this.java || this.kotlin) return `${el}.getAttribute(${this.str(name)})`
    if (this.python) return `${el}.get_attribute(${this.str(name)})`
    return `${el}.GetAttribute(${this.str(name)})`
  }

  private enabled(el: string): string {
    if (this.java) return `${el}.isEnabled()`
    if (this.kotlin) return `${el}.isEnabled`
    if (this.python) return `${el}.is_enabled()`
    return `${el}.Enabled`
  }

  private assertEquals(expected: string, actual: string): string {
    if (this.java) return `assertEquals(${expected}, ${actual});`
    if (this.kotlin) return `assertEquals(${expected}, ${actual})`
    if (this.python) return `assert ${actual} == ${expected}`
    return `Assert.That(${actual}, Is.EqualTo(${expected}));`
  }

  private assertTrue(condition: string, negated = false): string {
    if (this.java) return `${negated ? 'assertFalse' : 'assertTrue'}(${condition});`
    if (this.kotlin) return `${negated ? 'assertFalse' : 'assertTrue'}(${condition})`
    if (this.python) return `assert ${negated ? 'not ' : ''}${condition}`
    return `Assert.That(${condition}, Is.${negated ? 'False' : 'True'});`
  }

  private assertion(l: PageLocator.Appium, a: Assertion): string[] {
    const el = removeSuffix(this.visibleElement(l), ';')
    let line: string
    if (a === Assertion.Visible) line = this.waitFor(l, WaitState.VISIBLE)
    else if (a === Assertion.Hidden) line = this.waitFor(l, WaitState.HIDDEN)
    else if (a instanceof Assertion.HasText) line = this.assertEquals(this.str(a.text), this.text(el))
    else if (a instanceof Assertion.ContainsText) {
      if (this.python) line = `assert ${this.str(a.text)} in ${this.text(el)}`
      else if (this.csharp) line = `Assert.That(${this.text(el)}, Does.Contain(${this.str(a.text)}));`
      else line = this.assertTrue(`${this.text(el)}.contains(${this.str(a.text)})`)
    } else if (a instanceof Assertion.HasValue) {
      // Android keeps the content of an input in its text, iOS in its value.
      line = this.assertEquals(this.str(a.value), this.android ? this.text(el) : this.attribute(el, 'value'))
    } else if (a instanceof Assertion.Enabled) line = this.assertTrue(this.enabled(el), !a.enabled)
    else {
      // Assertion.Checked
      line = this.android ? this.assertEquals(this.str('true'), this.attribute(el, 'checked')) : this.assertEquals(this.str('1'), this.attribute(el, 'value'))
    }
    return [line]
  }

  // ---- gestures

  private literal(v: string | number | Raw): string {
    return typeof v === 'string' ? this.str(v) : String(v)
  }

  private script(name: string, ...argumentList: [string, string | number | Raw][]): string {
    const lit = (v: string | number | Raw) => this.literal(v)
    let map: string
    if (this.java) map = 'Map.of(' + argumentList.map(([k, v]) => `${this.str(k)}, ${lit(v)}`).join(', ') + ')'
    else if (this.kotlin) map = 'mapOf(' + argumentList.map(([k, v]) => `${this.str(k)} to ${lit(v)}`).join(', ') + ')'
    else if (this.python) map = '{' + argumentList.map(([k, v]) => `${this.str(k)}: ${lit(v)}`).join(', ') + '}'
    else map = 'new Dictionary<string, object> { ' + argumentList.map(([k, v]) => `{ ${this.str(k)}, ${lit(v)} }`).join(', ') + ' }'
    if (this.java) return `((JavascriptExecutor) driver).executeScript(${this.str(`mobile: ${name}`)}, ${map});`
    if (this.kotlin) return `(driver as JavascriptExecutor).executeScript(${this.str(`mobile: ${name}`)}, ${map})`
    if (this.python) return `driver.execute_script(${this.str(`mobile: ${name}`)}, ${map})`
    return `driver.ExecuteScript(${this.str(`mobile: ${name}`)}, ${map});`
  }

  private elementId(l: PageLocator.Appium): Raw {
    if (this.java) return new Raw(`((RemoteWebElement) ${this.find(l)}).getId()`)
    if (this.kotlin) return new Raw(`(${this.find(l)} as RemoteWebElement).id`)
    if (this.python) return new Raw(`${this.find(l)}.id`)
    return new Raw(`((WebElement)${this.find(l)}).Id`)
  }

  private windowSize(dimension: string): Raw {
    if (this.java) return new Raw(`driver.manage().window().getSize().get${dimension}()`)
    if (this.kotlin) return new Raw(`driver.manage().window().size.${dimension.toLowerCase()}`)
    if (this.python) return new Raw(`driver.get_window_size()[${this.str(dimension.toLowerCase())}]`)
    return new Raw(`driver.Manage().Window.Size.${dimension}`)
  }

  private swipe(direction: string): string {
    if (this.android) {
      return this.script(
        'swipeGesture',
        ['left', 0],
        ['top', 0],
        ['width', this.windowSize('Width')],
        ['height', this.windowSize('Height')],
        ['direction', direction],
        ['percent', new Raw(SWIPE_PERCENT)],
      )
    }
    return this.script('swipe', ['direction', direction])
  }

  private longPress(l: PageLocator.Appium, ms: number): string {
    if (this.android) return this.script('longClickGesture', ['elementId', this.elementId(l)], ['duration', ms])
    return this.script('touchAndHold', ['elementId', this.elementId(l)], ['duration', new Raw(doubleToString(ms / 1000.0))])
  }

  private doubleTap(l: PageLocator.Appium): string {
    return this.script(this.android ? 'doubleClickGesture' : 'doubleTap', ['elementId', this.elementId(l)])
  }

  private scrollUntilVisible(l: PageLocator.Appium, step: ScriptRecorder.ScrollUntilVisible): string[] {
    const gesture = this.swipe(step.direction)
    if (this.java) {
      return [`for (int i = 0; i < ${step.maxSwipes} && ${this.findAll(l)}.stream().noneMatch(WebElement::isDisplayed); i++) {`, `    ${gesture}`, '}']
    }
    if (this.kotlin) {
      return [`for (i in 0 until ${step.maxSwipes}) {`, `    if (${this.findAll(l)}.any { it.isDisplayed }) break`, `    ${gesture}`, '}']
    }
    if (this.python) {
      return [`for _ in range(${step.maxSwipes}):`, `    if any(e.is_displayed() for e in ${this.findAll(l)}): break`, `    ${gesture}`]
    }
    return [`for (var i = 0; i < ${step.maxSwipes} && !${this.findAll(l)}.Any(e => e.Displayed); i++) {`, `    ${gesture}`, '}']
  }

  private back(): string {
    if (this.python) return 'driver.back()'
    if (this.csharp) return 'driver.Navigate().Back();'
    if (this.java) return 'driver.navigate().back();'
    return 'driver.navigate().back()'
  }

  // ---- steps

  private noLocator(what: string, target: Target): string[] {
    return [this.comment(`${what} ${target.code()}: no unique Appium locator for this element, give it an id or accessibility id`)]
  }

  private withNote(lines: string[], unverified: boolean): string[] {
    if (unverified && lines.length > 0) return [...lines.slice(0, -1), lines[lines.length - 1] + '  ' + this.comment('check: matched against the screen before the previous action')]
    return lines
  }

  private onElement(what: string, target: Target, unverified: boolean, make: (l: PageLocator.Appium) => string[]): string[] {
    const l = target.appium
    if (l === undefined) return this.noLocator(what, target)
    return this.withNote(make(l), unverified)
  }

  private withWaiter<T>(timeoutMs: number | undefined, block: () => T): T {
    this.waiter = this.waiterFor(timeoutMs)
    try {
      return block()
    } finally {
      this.waiter = 'wait'
    }
  }

  lines(step: Step): string[] {
    const csharp = this.csharp
    const semi = this.semi
    if (step instanceof ScriptRecorder.Tap) {
      return this.onElement('tap', step.target, step.unverified, (it) => [`${this.find(it)}.${csharp ? 'Click' : 'click'}()${semi}`])
    }
    if (step instanceof ScriptRecorder.LongPress) {
      return this.onElement('long press', step.target, step.unverified, (it) => [this.longPress(it, step.durationMs)])
    }
    if (step instanceof ScriptRecorder.DoubleTap) {
      return this.onElement('double tap', step.target, step.unverified, (it) => [this.doubleTap(it)])
    }
    if (step instanceof ScriptRecorder.Fill) {
      return this.onElement('fill', step.target, step.unverified, (it) => [
        // Mobilewright fill replaces the text, so clear first.
        `${this.find(it)}.${csharp ? 'Clear' : 'clear'}()${semi}`,
        `${this.find(it)}.${csharp ? 'SendKeys' : this.python ? 'send_keys' : 'sendKeys'}(${this.str(step.text)})${semi}`,
      ])
    }
    if (step instanceof ScriptRecorder.Expect) {
      return this.onElement('expect', step.target, false, (it) => this.withWaiter(step.timeoutMs, () => this.assertion(it, step.assertion)))
    }
    if (step instanceof ScriptRecorder.ExpectCount) {
      return [this.comment(`expect count ${step.count} of ${step.target.withoutNth().code()}: no Appium form, the unique Appium locator of the element matches one element`)]
    }
    if (step instanceof ScriptRecorder.WaitFor) {
      return this.onElement('wait', step.target, false, (it) => this.withWaiter(step.timeoutMs, () => [this.waitFor(it, step.state)]))
    }
    if (step instanceof ScriptRecorder.Swipe) return [this.swipe(step.direction)]
    if (step instanceof ScriptRecorder.ScrollUntilVisible) {
      return this.onElement('scroll until visible', step.target, false, (it) => this.scrollUntilVisible(it, step))
    }
    if (step instanceof ScriptRecorder.Button) {
      if (step.name === 'HOME') return [this.android ? this.script('pressKey', ['keycode', 3]) : this.script('pressButton', ['name', 'home'])]
      return [this.comment(`press button ${step.name}: no Appium form`)]
    }
    if (step === ScriptRecorder.GoBack) return [this.back()]
    if (step instanceof ScriptRecorder.UnfocusedText) return [this.comment(`typed ${this.str(step.text)}: tap the field first so it can be recorded as fill`)]
    return [this.comment(AppiumSteps.appiumNote((step as ScriptRecorder.Note).text))]
  }
}
