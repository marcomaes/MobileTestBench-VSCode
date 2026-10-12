// ported-from: core/pageobject/LocatorCode.kt
import type { LocatorSuggestion } from '../inspector/locators'
import { AppiumStrategy, PageLocator, PageObjectGenerator, PageObjectLanguage } from './pageObject'

/** What a locator from the Locators tab is copied as. Stored by [name] in the settings. */
export interface LocatorLanguage {
  readonly name: string
  readonly label: string
  readonly appium: PageObjectLanguage | undefined
  readonly webdriverio: boolean
  toString(): string
}

const language = (name: string, label: string, appium: PageObjectLanguage | undefined, webdriverio = false): LocatorLanguage => ({ name, label, appium, webdriverio, toString: () => label })

const AS_SHOWN = language('AS_SHOWN', 'As shown', undefined)
const MOBILEWRIGHT = language('MOBILEWRIGHT', 'Mobilewright (TypeScript / JavaScript)', undefined)
const APPIUM_JAVA = language('APPIUM_JAVA', 'Appium Java', PageObjectLanguage.APPIUM_JAVA)
const APPIUM_KOTLIN = language('APPIUM_KOTLIN', 'Appium Kotlin', PageObjectLanguage.APPIUM_KOTLIN)
const APPIUM_PYTHON = language('APPIUM_PYTHON', 'Appium Python', PageObjectLanguage.APPIUM_PYTHON)
const APPIUM_CSHARP = language('APPIUM_CSHARP', 'Appium C#', PageObjectLanguage.APPIUM_CSHARP)
const APPIUM_WEBDRIVERIO = language('APPIUM_WEBDRIVERIO', 'Appium JavaScript (WebdriverIO)', undefined, true)

const entries: readonly LocatorLanguage[] = [AS_SHOWN, MOBILEWRIGHT, APPIUM_JAVA, APPIUM_KOTLIN, APPIUM_PYTHON, APPIUM_CSHARP, APPIUM_WEBDRIVERIO]

export const LocatorLanguage = {
  AS_SHOWN,
  MOBILEWRIGHT,
  APPIUM_JAVA,
  APPIUM_KOTLIN,
  APPIUM_PYTHON,
  APPIUM_CSHARP,
  APPIUM_WEBDRIVERIO,
  entries,

  fromName(name: string | null | undefined): LocatorLanguage {
    return entries.find((it) => it.name === name) ?? AS_SHOWN
  },
}

/** The text a locator row is copied or inserted as. [note] is set when the row has no form in the chosen language. */
export class LocatorText {
  constructor(
    readonly text: string,
    readonly note?: string,
  ) {}
}

export const LocatorCode = {
  /** The locator as code in [language], or undefined when the row has no form in that language (a Mobilewright row for Java, an Appium row for Mobilewright). */
  render(suggestion: LocatorSuggestion, language: LocatorLanguage, wholeLine = false): string | undefined {
    const code = renderBare(suggestion, language)
    if (code === undefined) return undefined
    return wholeLine ? LocatorCode.wholeLine(code, suggestion, language) : code
  },

  /**
   * The bare [code] wrapped as a statement: Java/Kotlin `driver.findElement(By.id("x"))`, Python `driver.find_element(AppiumBy.ID, "x")`,
   * C# `driver.FindElement(By.Id("x"))`, WebdriverIO `await $('~x')`. As shown and Mobilewright are already a line (`screen.getByTestId(...)`) and stay as they are.
   */
  wholeLine(code: string, suggestion: LocatorSuggestion, language: LocatorLanguage): string {
    if (suggestion.framework !== 'Appium') return code
    if (language.webdriverio) return `await ${code}`
    if (language === LocatorLanguage.APPIUM_JAVA || language === LocatorLanguage.APPIUM_KOTLIN) return `driver.findElement(${code})`
    if (language === LocatorLanguage.APPIUM_PYTHON) return `driver.find_element(${removeSuffix(removePrefix(code, '('), ')')})`
    if (language === LocatorLanguage.APPIUM_CSHARP) return `driver.FindElement(${code})`
    return code
  },

  /** What to put on the clipboard: the rendered code, or the expression as shown plus a note when there is no form. */
  textFor(suggestion: LocatorSuggestion, language: LocatorLanguage, wholeLine = false): LocatorText {
    const rendered = LocatorCode.render(suggestion, language, wholeLine)
    if (rendered !== undefined) return new LocatorText(rendered)
    return new LocatorText(
      suggestion.expression,
      `No ${shortName(language)} form for ${suggestion.framework === 'Mobilewright' ? 'a Mobilewright' : 'an Appium'} locator, used as shown`,
    )
  },

  /** The menu label of a tree menu item: with a language, the framework part names it ("Copy Appium Java accessibility id"). */
  menuLabel(suggestion: LocatorSuggestion, language: LocatorLanguage): string {
    if (language === LocatorLanguage.AS_SHOWN || LocatorCode.render(suggestion, language) === undefined) return `Copy ${suggestion.framework} ${suggestion.strategy}`
    return `Copy ${language === LocatorLanguage.MOBILEWRIGHT ? 'Mobilewright' : language.label} ${suggestion.strategy}`
  },
}

const removePrefix = (s: string, p: string): string => (s.startsWith(p) ? s.slice(p.length) : s)
const removeSuffix = (s: string, p: string): string => (s.endsWith(p) ? s.slice(0, s.length - p.length) : s)

function renderBare(suggestion: LocatorSuggestion, language: LocatorLanguage): string | undefined {
  const appium = language.appium
  if (language === LocatorLanguage.AS_SHOWN) return suggestion.expression
  if (language === LocatorLanguage.MOBILEWRIGHT) return suggestion.framework === 'Mobilewright' ? suggestion.expression : undefined
  if (appium !== undefined && suggestion.framework === 'Appium') {
    return PageObjectGenerator.appiumCode(appium, new PageLocator.Appium(AppiumStrategy.fromLocatorName(suggestion.strategy), suggestion.expression))
  }
  if (language.webdriverio && suggestion.framework === 'Appium') {
    return WebdriverIo.element(new PageLocator.Appium(AppiumStrategy.fromLocatorName(suggestion.strategy), suggestion.expression))
  }
  return undefined
}

const shortName = (language: LocatorLanguage): string => (language === LocatorLanguage.MOBILEWRIGHT ? 'Mobilewright' : language.label)

/** Appium locators as WebdriverIO selectors: `$('~login')`. Pure text generation. */
export const WebdriverIo = {
  /** A single quoted JavaScript string. */
  quote(text: string): string {
    return "'" + text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r') + "'"
  },

  /** The selector string: `~` for accessibility id, a prefix for the other strategies, the bare XPath. */
  selector(l: PageLocator.Appium): string {
    switch (l.strategy) {
      case 'ID':
        return `id=${l.value}`
      case 'ACCESSIBILITY_ID':
        return `~${l.value}`
      case 'ANDROID_UIAUTOMATOR':
        return `android=${l.value}`
      case 'IOS_PREDICATE':
        return `-ios predicate string:${l.value}`
      case 'IOS_CLASS_CHAIN':
        return `-ios class chain:${l.value}`
      case 'XPATH':
        return l.value
    }
  },

  /** `$('~login')`, the element without `await`. */
  element(l: PageLocator.Appium): string {
    return `$(${WebdriverIo.quote(WebdriverIo.selector(l))})`
  },
}
