// ported-from: core/inspector/AppiumLocatorQuery.kt
import { Cursor } from './appiumSyntax'
import { IllegalArgumentException, requireThat } from './illegalArgumentException'
import { IosClassChainQuery } from './iosClassChainQuery'
import { IosPredicateQuery } from './iosPredicateQuery'
import { LocatorQuery } from './locatorQuery'
import type { UiNode } from './uiNode'
import { UiSelectorQuery } from './uiSelectorQuery'

export interface AppiumBy {
  readonly name: string
  readonly label: string
}

const by = (name: string, label: string): AppiumBy => Object.freeze({ name, label })
const ID = by('ID', 'id')
const ACCESSIBILITY_ID = by('ACCESSIBILITY_ID', 'accessibility id')
const ANDROID_UIAUTOMATOR = by('ANDROID_UIAUTOMATOR', '-android uiautomator')
const IOS_PREDICATE = by('IOS_PREDICATE', '-ios predicate string')
const IOS_CLASS_CHAIN = by('IOS_CLASS_CHAIN', '-ios class chain')
const XPATH = by('XPATH', 'xpath')
const CLASS_NAME = by('CLASS_NAME', 'class name')

export const AppiumBy = {
  ID,
  ACCESSIBILITY_ID,
  ANDROID_UIAUTOMATOR,
  IOS_PREDICATE,
  IOS_CLASS_CHAIN,
  XPATH,
  CLASS_NAME,
  entries: [ID, ACCESSIBILITY_ID, ANDROID_UIAUTOMATOR, IOS_PREDICATE, IOS_CLASS_CHAIN, XPATH, CLASS_NAME] as readonly AppiumBy[],
}

export interface AppiumLocator {
  readonly by: AppiumBy
  readonly value: string
}

const prefixForm = /^(id|accessibility id|-android uiautomator|-ios predicate string|-ios class chain|xpath|class name)\s*=\s*(.*)$/is
const codeHint = /(?:\b(?:AppiumBy|MobileBy|By)\s*\.\s*\w)|(?:\bfind_?elements?\s*\()/i
const wrapper = /\bfind_?elements?\s*\(/i
const byToken = /^(?:AppiumBy|MobileBy|By)\s*\.\s*(\w+)\s*/
const valueKeyword = /value\s*=\s*/y

const trimEndSemicolons = (s: string): string => s.replace(/;+$/, '')

/**
 * Evaluates an Appium locator typed in any form people copy: the strategy and value as the Locators tab shows them
 * (`id=com.x:id/y`, `accessibility id=Login`, `-android uiautomator=new UiSelector()...`, `-ios predicate string=...`,
 * `-ios class chain=...`, `xpath=...`), or code: Java/Kotlin `By.id("x")` / `AppiumBy.accessibilityId("x")`, C#
 * `By.Id("x")` / `MobileBy.AccessibilityId("x")`, Python `(AppiumBy.ID, "x")`, each optionally inside
 * `driver.findElement(...)`, `findElements(...)`, `find_element(...)`, `FindElement(...)`.
 * Anything outside the subset is refused with a "not supported yet: ..." message, never answered with a guess.
 */
export const AppiumLocatorQuery = {
  /** True when [text] is meant as an Appium locator (a strategy prefix or Appium/Selenium code), so it must not be tried as XPath or Mobilewright. */
  looksLikeAppium(text: string): boolean {
    const t = text.trim()
    if (t.startsWith('/')) return false
    if (prefixForm.test(t)) return true
    // Look only before the first string, so a quoted `By.id` inside a Mobilewright text locator does not count.
    const quote = t.search(/["']/)
    const head = quote < 0 ? t : t.slice(0, quote)
    return codeHint.test(head)
  },

  find(text: string, root: UiNode): UiNode[] {
    return AppiumLocatorQuery.evaluate(AppiumLocatorQuery.parse(text), root)
  },

  parse(text: string): AppiumLocator {
    const t = trimEndSemicolons(text.trim()).trim()
    const m = prefixForm.exec(t)
    if (m) {
      const label = m[1].toLowerCase()
      const kind = AppiumBy.entries.find((it) => it.label.toLowerCase() === label)!
      let value = m[2].trim()
      if (kind === AppiumBy.ID || kind === AppiumBy.ACCESSIBILITY_ID || kind === AppiumBy.CLASS_NAME) value = unquote(value)
      requireThat(value.length > 0, `${kind.label}= needs a value`)
      return { by: kind, value }
    }
    let args = t
    const call = wrapper.exec(t)
    if (call && !/["']/.test(t.slice(0, call.index))) {
      const open = call.index + call[0].length - 1
      const close = LocatorQuery.closingParenthesis(t, open)
      if (close === undefined) throw new IllegalArgumentException('Missing closing parenthesis')
      const rest = trimEndSemicolons(t.slice(close + 1).trim()).trim()
      requireThat(rest.length === 0, `not supported yet: ${rest} after the locator, only the locator itself is evaluated`)
      args = t.slice(open + 1, close)
    }
    return parseArguments(args)
  },

  evaluate(locator: AppiumLocator, root: UiNode): UiNode[] {
    const all = [...root.walk()].filter((it) => !it.isRoot)
    const android = root.platform === 'ANDROID'
    const value = locator.value
    switch (locator.by) {
      case AppiumBy.ID:
        return all.filter((it) => (android ? it.attr('resource-id') : it.attr('name')) === value)
      case AppiumBy.ACCESSIBILITY_ID:
        return all.filter((it) => (android ? it.attr('content-desc') : it.attr('name')) === value)
      case AppiumBy.CLASS_NAME:
        return all.filter((it) => it.rawType === value)
      case AppiumBy.XPATH:
        return LocatorQuery.findXPath(value, root)
      case AppiumBy.ANDROID_UIAUTOMATOR:
        return UiSelectorQuery.find(value, root)
      case AppiumBy.IOS_PREDICATE:
        return IosPredicateQuery.find(value, root)
      default:
        return IosClassChainQuery.find(value, root)
    }
  },
}

function unquote(value: string): string {
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0] && value.indexOf(value[0], 1) === value.length - 1 ? value.slice(1, value.length - 1) : value
}

function parseArguments(raw: string): AppiumLocator {
  let a = raw.trim()
  if (a.startsWith('(') && LocatorQuery.closingParenthesis(a, 0) === a.length - 1) a = a.slice(1, a.length - 1).trim()
  a = a.replace(/^by\s*=\s*/, '')
  const m = byToken.exec(a)
  if (!m) {
    throw new IllegalArgumentException(`not supported yet: ${a.slice(0, 40)}, write the locator as By.id("..."), AppiumBy.accessibilityId("...") or (AppiumBy.ID, "...")`)
  }
  const kind = strategyOf(m[1], a.slice(0, a.indexOf(m[1])).trim() + m[1])
  const c = new Cursor(a, m.index + m[0].length)
  let value: string
  if (c.eat('(')) {
    value = c.literal()
    if (!c.eat(')')) throw new IllegalArgumentException(`not supported yet: ${c.rest().slice(0, 40)}`)
  } else if (c.eat(',')) {
    c.skipWhitespace()
    valueKeyword.lastIndex = c.i
    const kw = valueKeyword.exec(a)
    if (kw) c.i = kw.index + kw[0].length
    value = c.literal()
  } else {
    throw new IllegalArgumentException(`not supported yet: ${a.slice(0, 40)}`)
  }
  c.requireEnd()
  requireThat(value.length > 0, 'The locator value is empty')
  return { by: kind, value }
}

/** Maps the Java/Kotlin/C# method name or the Python constant to a strategy. */
function strategyOf(name: string, shown: string): AppiumBy {
  switch (name.toLowerCase().replaceAll('_', '')) {
    case 'id':
      return AppiumBy.ID
    case 'accessibilityid':
      return AppiumBy.ACCESSIBILITY_ID
    case 'androiduiautomator':
      return AppiumBy.ANDROID_UIAUTOMATOR
    case 'iosnspredicatestring':
    case 'iospredicate':
    case 'iosnspredicate':
      return AppiumBy.IOS_PREDICATE
    case 'iosclasschain':
      return AppiumBy.IOS_CLASS_CHAIN
    case 'xpath':
      return AppiumBy.XPATH
    case 'classname':
      return AppiumBy.CLASS_NAME
    default:
      throw new IllegalArgumentException(`not supported yet: ${shown} (supported: id, accessibility id, UiSelector, iOS predicate, iOS class chain, xpath, class name)`)
  }
}
