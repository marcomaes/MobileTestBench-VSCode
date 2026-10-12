// ported-from: core/inspector/LocatorExtraction.kt
import { LocatorQuery } from './locatorQuery'

/** A locator found in test code, in a form [LocatorQuery.find] understands. */
export interface ExtractedLocator {
  readonly expression: string
}

const strategyNames = 'accessibility id|-android uiautomator|-ios predicate string|-ios class chain|class name|xpath|id'
const mobilewrightStart = /\b(?:screen\s*\.\s*)?getBy(?:TestId|Role|Label|Text)\s*\(/
const chainCall = /\s*\.\s*(getBy(?:TestId|Role|Label|Text)|nth|first|last)\s*\(/y
const wrapperStart = /\bfind_?elements?\s*\(/i
const byToken = /\b(?:AppiumBy|MobileBy|By)\s*\.\s*\w+/
const prefixStart = new RegExp(`(?<![\\w-])(${strategyNames})\\s*=\\s*(["'])`, 'i')
const stringForm = new RegExp(`^\\s*(["'])(${strategyNames})\\1\\s*,\\s*`, 'i')
const prefixedValue = new RegExp(`^(${strategyNames})\\s*=\\s*\\S.*$`, 'is')
const literalStart = /["']/g
const callName = /getBy\w+|nth|first|last/
const valueKeyword = /value\s*=\s*/y

/** Index of the last character of a regex match. */
const lastIndex = (m: RegExpExecArray): number => m.index + m[0].length - 1

const trimChar = (s: string, c: string): string => {
  let a = 0
  let b = s.length
  while (a < b && s[a] === c) a++
  while (b > a && s[b - 1] === c) b--
  return s.slice(a, b)
}

/**
 * Finds the locator expression in a line (or selection) of test code, so an editor action can try it on the device.
 * It cuts out only the locator: `await screen.getByTestId("a").tap()` gives `screen.getByTestId("a")`,
 * `driver.findElement(By.id("x")).click()` gives `driver.findElement(By.id("x"))`.
 * Recognized: Mobilewright getBy chains (with nth/first/last), Appium/Selenium `By`/`AppiumBy`/`MobileBy` forms (Java, Kotlin, C#,
 * Python constants and tuples, `find_element(...)` wrappers, also the string forms `find_element("xpath", "...")`),
 * quoted values after `id=`, `xpath=` etc. and a quoted XPath string.
 */
export const LocatorExtraction = {
  /** [text] is a selection (any number of lines) or one line. Undefined when no locator is found. */
  extract(text: string): ExtractedLocator | undefined {
    const flat = text
      .split(/\r\n|\n|\r/)
      .map((it) => it.trim())
      .join(' ')
      .trim()
    if (flat.length === 0) return undefined
    const candidates: { first: number; build: () => string | undefined }[] = []
    const w = wrapperStart.exec(flat)
    if (w) candidates.push({ first: w.index, build: () => wrapper(flat, w) })
    const b = byToken.exec(flat)
    if (b) candidates.push({ first: b.index, build: () => byForm(flat, b) })
    const m = mobilewrightStart.exec(flat)
    if (m) candidates.push({ first: m.index, build: () => mobilewright(flat, m) })
    const p = prefixStart.exec(flat)
    if (p) candidates.push({ first: p.index, build: () => prefixed(flat, p) })
    candidates.sort((x, y) => x.first - y.first) // stable, like sortedBy
    for (const { build } of candidates) {
      const found = build()
      if (found !== undefined) return { expression: found }
    }
    const quoted = quotedXPath(flat)
    if (quoted !== undefined) return { expression: quoted }
    // A selection made inside the quotes of an XPath.
    const bare = trimChar(flat.trim(), ';')
    if (bare.startsWith('/') || bare.startsWith('(/')) return { expression: bare }
    return undefined
  },
}

function mobilewright(text: string, start: RegExpExecArray): string {
  let sb = 'screen.'
  let next: RegExpExecArray | null = start
  let first = true
  while (next !== null) {
    const name = callName.exec(next[0])![0]
    const open = lastIndex(next)
    const close = LocatorQuery.closingParenthesis(text, open)
    const end = close ?? text.length - 1
    if (!first) sb += '.'
    sb += name + text.slice(open, end + 1)
    first = false
    if (close === undefined) break
    chainCall.lastIndex = close + 1
    next = chainCall.exec(text)
  }
  return sb
}

function wrapper(text: string, m: RegExpExecArray): string | undefined {
  const open = lastIndex(m)
  const close = LocatorQuery.closingParenthesis(text, open)
  if (close === undefined) return text.slice(m.index)
  const call = text.slice(m.index, close + 1)
  const inner = text.slice(open + 1, close)
  const sf = stringForm.exec(inner)
  if (sf) {
    const value = literalAt(inner, lastIndex(sf) + 1)
    if (value === undefined) return call
    return `${sf[2].toLowerCase()}=${value}`
  }
  return call
}

function byForm(text: string, m: RegExpExecArray): string {
  let i = lastIndex(m) + 1
  while (i < text.length && /\s/.test(text[i])) i++
  if (i < text.length && text[i] === '(') {
    const close = LocatorQuery.closingParenthesis(text, i)
    if (close === undefined) return text.slice(m.index)
    return text.slice(m.index, close + 1)
  }
  if (i < text.length && text[i] === ',') {
    let j = i + 1
    while (j < text.length && /\s/.test(text[j])) j++
    valueKeyword.lastIndex = j
    const kw = valueKeyword.exec(text)
    if (kw) j = kw.index + kw[0].length
    const end = literalEnd(text, j) ?? text.length
    return text.slice(m.index, end)
  }
  return text.slice(m.index, lastIndex(m) + 1)
}

function prefixed(text: string, m: RegExpExecArray): string | undefined {
  const value = literalAt(text, lastIndex(m))
  if (value === undefined) return undefined
  return `${m[1].toLowerCase()}=${value}`
}

function quotedXPath(text: string): string | undefined {
  let i = 0
  while (i < text.length) {
    literalStart.lastIndex = i
    const m = literalStart.exec(text)
    if (!m) return undefined
    const value = literalAt(text, m.index)
    if (value === undefined) return undefined
    const end = literalEnd(text, m.index)
    if (end === undefined) return undefined
    if (value.startsWith('/') || value.startsWith('(/') || prefixedValue.test(value)) return value
    i = end
  }
  return undefined
}

/** The unescaped contents of the string literal that starts at [start] (its opening quote), or undefined if it is not closed. */
function literalAt(text: string, start: number): string | undefined {
  if (start >= text.length || (text[start] !== '"' && text[start] !== "'")) return undefined
  const end = literalEnd(text, start)
  if (end === undefined) return undefined
  return text.slice(start + 1, end - 1).replace(/\\(.)/g, (_m, c: string) => c)
}

/** The index just after the string literal starting at [start], or undefined. */
function literalEnd(text: string, start: number): number | undefined {
  if (start >= text.length) return undefined
  const q = text[start]
  if (q !== '"' && q !== "'") return undefined
  let i = start + 1
  while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1
  return i < text.length ? i + 1 : undefined
}
