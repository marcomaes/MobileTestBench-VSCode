// ported-from: core/inspector/LocatorQuery.kt
import { rectContainsRect } from '../model'
import { AppiumLocatorQuery } from './appiumLocatorQuery'
import { IllegalArgumentException, requireThat } from './illegalArgumentException'
import { MobilewrightLocators, type Derived } from './locators'
import type { UiNode } from './uiNode'
import { evaluateXPath, XPathError } from './xpathEngine'

/** `/hierarchy/android.widget.FrameLayout[1]/...` as generated for "xpath (absolute)". */
const absolutePath = /^(?:\/[^/[\]\s@=()'"]+(?:\[\d+])?)+$/
const pathSegment = /\/([^/[\]]+)(?:\[(\d+)])?/g
const callRegex = /(getBy(?:TestId|Role|Label|Text)|nth|first|last)\(/y
const stringLiteral = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/
const roleName = /name\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/

const USAGE =
  'Use screen.getByTestId(\'...\'), getByRole, getByLabel, getByText (chain them to scope to a parent), an XPath starting with /, or an Appium locator such as id=..., accessibility id=... or By.id("...")'

/**
 * Evaluates a locator typed by the user against a hierarchy, so it can be tried before it goes into a test.
 * Supported: Mobilewright `screen.getByTestId/getByRole/getByLabel/getByText(...)`, chained to scope to a parent and with
 * `.nth(n)`, `.first()`, `.last()`, XPath (starting with `/` or `(`) and Appium locators (see [AppiumLocatorQuery]).
 */
export const LocatorQuery = {
  /** All matching nodes in document order. Throws [IllegalArgumentException] with a readable message for bad input. */
  find(expression: string, root: UiNode): UiNode[] {
    const text = expression.trim()
    requireThat(text.length > 0, 'Empty locator')
    if (AppiumLocatorQuery.looksLikeAppium(text)) return AppiumLocatorQuery.find(text, root)
    if (absolutePath.test(text) || text.startsWith('/') || text.startsWith('(')) return LocatorQuery.findXPath(text, root)
    return findByMobilewright(text, root)
  },

  /** An XPath, either the absolute `/a/b[2]` form (walked without the XPath engine) or any XPath the engine accepts. */
  findXPath(text: string, root: UiNode): UiNode[] {
    const xpath = text.trim()
    requireThat(xpath.length > 0, 'Empty XPath')
    return absolutePath.test(xpath) ? findByAbsolutePath(xpath, root) : findByXPath(xpath, root)
  },

  /** The index of the parenthesis that closes the one at [open], skipping quoted strings; undefined when there is none. */
  closingParenthesis(text: string, open: number): number | undefined {
    let depth = 0
    let i = open
    while (i < text.length) {
      const c = text[i]
      if (c === '(') depth++
      else if (c === ')') {
        if (--depth === 0) return i
      } else if (c === "'" || c === '"') {
        i++
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      }
      i++
    }
    return undefined
  },
}

/** `screen.getByX(...)` calls chained with `.getByX(...)` (scoped to the bounds of the previous matches), `.nth(n)`, `.first()`, `.last()`. */
function findByMobilewright(text: string, root: UiNode): UiNode[] {
  const all = [...root.walk()].filter((it) => !it.isRoot)
  let current: UiNode[] | undefined // undefined: the whole screen
  let pos = text.startsWith('screen.') ? 'screen.'.length : 0
  while (pos < text.length) {
    callRegex.lastIndex = pos
    const match = callRegex.exec(text)
    if (!match) throw new IllegalArgumentException(USAGE)
    const open = match.index + match[0].length - 1
    const close = LocatorQuery.closingParenthesis(text, open)
    if (close === undefined) throw new IllegalArgumentException('Missing closing parenthesis')
    const args = text.slice(open + 1, close)
    const name = match[1]
    if (name === 'nth') {
      const n = /^[+-]?\d+$/.test(args.trim()) ? parseInt(args.trim(), 10) : undefined
      if (n === undefined) throw new IllegalArgumentException('nth() takes a number')
      const item = (current ?? [])[n]
      current = n >= 0 && item !== undefined ? [item] : []
    } else if (name === 'first') {
      current = (current ?? []).slice(0, 1)
    } else if (name === 'last') {
      current = (current ?? []).slice(-1)
    } else {
      const derived = derive(name.slice('getBy'.length), args)
      const parents = current
      current = all.filter(
        (n) =>
          MobilewrightLocators.matches(n, derived) &&
          (parents === undefined || parents.some((p) => p !== n && p.bounds !== undefined && n.bounds !== undefined && rectContainsRect(p.bounds, n.bounds))),
      )
    }
    pos = close + 1
    if (pos < text.length) {
      requireThat(text[pos] === '.', USAGE)
      pos++
    }
  }
  return current ?? []
}

function derive(kind: string, args: string): Derived {
  const first = stringLiteral.exec(args)
  if (!first) throw new IllegalArgumentException('Expected a quoted string argument')
  const value = unescape(first)
  switch (kind) {
    case 'TestId':
      return { kind: 'TEST_ID', value }
    case 'Role': {
      const n = roleName.exec(args)?.[1]
      return { kind: 'ROLE', value, name: n === undefined ? undefined : unescape(stringLiteral.exec(n)!) }
    }
    case 'Label':
      return { kind: 'LABEL', value }
    default:
      return { kind: 'TEXT', value }
  }
}

function unescape(literal: RegExpExecArray): string {
  return (literal[1] ?? literal[2]).replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c))
}

/**
 * Walks the path segment by segment. The JDK XPath engine refuses expressions with more than 100 operators,
 * which a deeply nested screen exceeds, and this form needs no engine.
 */
function findByAbsolutePath(path: string, root: UiNode): UiNode[] {
  let current: UiNode[] = []
  let index = 0
  for (const match of path.matchAll(pathSegment)) {
    const type = match[1]
    const position = match[2] === undefined ? undefined : parseInt(match[2], 10)
    if (index === 0) {
      current = [root].filter((it) => it.rawType === type && (position === undefined || position === 1))
    } else {
      current = current.flatMap((parent) => {
        const sameType = parent.children.filter((it) => it.rawType === type)
        if (position === undefined) return sameType
        const item = sameType[position - 1]
        return position >= 1 && item !== undefined ? [item] : []
      })
    }
    index++
    if (current.length === 0) return []
  }
  return current
}

function findByXPath(expression: string, root: UiNode): UiNode[] {
  try {
    return evaluateXPath(expression, root)
  } catch (e) {
    if (e instanceof XPathError) throw new IllegalArgumentException(`Invalid XPath: ${e.message}`)
    throw e
  }
}
