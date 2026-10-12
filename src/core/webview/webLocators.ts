// ported-from: core/webview/WebLocators.kt
import { MobilecliJson } from '../mobilecliJson'
import { DomNode, WebViews } from './webView'

/** A locator for a DOM element. [domCount] is the number of matches in the loaded (possibly capped) DOM; the live count from the page replaces it when known. */
export interface WebLocator {
  readonly kind: string
  readonly value: string
  readonly domCount: number
}

/** Attributes meant for tests and stable identification, in order of preference. */
const STABLE_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label', 'placeholder', 'title', 'alt']

const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/

const quote = (value: string): string => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const nthOfType = (n: DomNode): number => {
  const siblings = n.parent?.children
  if (!siblings) return 1
  let count = 0
  for (const s of siblings) {
    if (s === n) break
    if (s.tag === n.tag) count++
  }
  return count + 1
}

const sameTagSiblings = (n: DomNode): number => n.parent?.children.filter((s) => s.tag === n.tag).length ?? 1

class Step {
  constructor(
    readonly tag: string | undefined,
    readonly id: string | undefined = undefined,
    readonly classes: string[] = [],
    readonly attr: [string, string] | undefined = undefined,
    readonly nth: number | undefined = undefined,
  ) {}

  render(): string {
    let sb = this.tag ?? ''
    if (this.id !== undefined) sb += IDENT.test(this.id) ? `#${this.id}` : `[id=${quote(this.id)}]`
    for (const c of this.classes) sb += '.' + c
    if (this.attr) sb += `[${this.attr[0]}=${quote(this.attr[1])}]`
    if (this.nth !== undefined) sb += `:nth-of-type(${this.nth})`
    return sb
  }

  matches(n: DomNode): boolean {
    const nodeClasses = n.classes
    return (
      (this.tag === undefined || n.tag === this.tag) &&
      (this.id === undefined || n.id === this.id) &&
      this.classes.every((c) => nodeClasses.includes(c)) &&
      (this.attr === undefined || n.attributes.get(this.attr[0]) === this.attr[1]) &&
      (this.nth === undefined || nthOfType(n) === this.nth)
    )
  }
}

/** Matches [steps] as a child chain; the first step may sit anywhere in the tree. */
function chainMatches(n: DomNode, steps: Step[], i: number): boolean {
  if (!steps[i].matches(n)) return false
  if (i === 0) return true
  const p = n.parent
  if (!p) return false
  return chainMatches(p, steps, i - 1)
}

const countCss = (root: DomNode, steps: Step[]): number => {
  let c = 0
  for (const n of root.descendants()) if (chainMatches(n, steps, steps.length - 1)) c++
  return c
}

/** True for `<svg>`/`<math>` and everything below: those elements live in another namespace, so a plain tag name in XPath never matches them. */
function foreign(n: DomNode): boolean {
  for (let c: DomNode | undefined = n; c; c = c.parent) if (c.tag === 'svg' || c.tag === 'math') return true
  return false
}

const xpathTag = (n: DomNode): string => (foreign(n) ? `*[local-name()='${n.tag}']` : n.tag)

const countWhere = (root: DomNode, pred: (n: DomNode) => boolean): number => {
  let c = 0
  for (const n of root.descendants()) if (pred(n)) c++
  return c
}

/** CSS selector and XPath generation with uniqueness checks against a parsed [DomPage]. */
export const WebLocators = {
  quote,

  /** An XPath string literal; uses concat() when the text holds both kinds of quote. */
  xpathLiteral(value: string): string {
    if (!value.includes("'")) return `'${value}'`
    if (!value.includes('"')) return `"${value}"`
    return 'concat(' + value.split("'").map((p) => `'${p}'`).join(', "\'", ') + ')'
  },

  cssSelector(node: DomNode, root: DomNode): WebLocator {
    const unique = (steps: Step[]): boolean => countCss(root, steps) === 1
    const result = (steps: Step[]): WebLocator => ({ kind: 'CSS', value: steps.map((s) => s.render()).join(' > '), domCount: countCss(root, steps) })
    if (node.id !== undefined) {
      const s = new Step(undefined, node.id)
      if (unique([s])) return result([s])
    }
    for (const name of STABLE_ATTRIBUTES) {
      const v = node.attributes.get(name)
      if (v === undefined || v.trim() === '') continue
      const s = new Step(node.tag, undefined, [], [name, v])
      if (unique([s])) return result([s])
    }
    const cls = node.classes.filter((c) => IDENT.test(c))
    if (cls.length > 0) {
      const s = new Step(node.tag, undefined, cls)
      if (unique([s])) return result([s])
    }
    // Path: tag:nth-of-type steps from the element up until the selector is unique, stopping at an ancestor with a unique id.
    const steps: Step[] = []
    let cur: DomNode | undefined = node
    while (cur) {
      const anchor = cur !== node && cur.id !== undefined && unique([new Step(undefined, cur.id)])
      if (anchor) {
        steps.unshift(new Step(undefined, cur.id))
        break
      }
      const ownClasses = cur === node ? [] : cur.classes.filter((c) => IDENT.test(c))
      steps.unshift(ownClasses.length > 0 ? new Step(cur.tag, undefined, ownClasses) : new Step(cur.tag, undefined, [], undefined, sameTagSiblings(cur) > 1 ? nthOfType(cur) : undefined))
      // At least element plus parent, so a bare "button" that happens to be unique today is not the answer.
      if ((steps.length >= 2 || cur.parent === undefined) && unique([...steps])) break
      cur = cur.parent
    }
    return result(steps)
  },

  xpath(node: DomNode, root: DomNode): WebLocator {
    const lit = WebLocators.xpathLiteral
    const id = node.id
    if (id !== undefined && countWhere(root, (n) => n.id === id) === 1) return { kind: 'XPath', value: `//${xpathTag(node)}[@id=${lit(id)}]`, domCount: 1 }
    for (const name of STABLE_ATTRIBUTES) {
      const v = node.attributes.get(name)
      if (v === undefined || v.trim() === '') continue
      if (countWhere(root, (n) => n.tag === node.tag && n.attributes.get(name) === v) === 1) return { kind: 'XPath', value: `//${xpathTag(node)}[@${name}=${lit(v)}]`, domCount: 1 }
    }
    // Path from the nearest ancestor with a unique id, else from <html>; an index only where same-tag siblings exist.
    const parts: string[] = []
    let cur: DomNode | undefined = node
    let prefix = ''
    while (cur) {
      const cid = cur.id
      if (cur !== node && cid !== undefined && countWhere(root, (n) => n.id === cid) === 1) {
        prefix = `//*[@id=${lit(cid)}]`
        break
      }
      parts.unshift(xpathTag(cur) + (sameTagSiblings(cur) > 1 ? `[${nthOfType(cur)}]` : ''))
      cur = cur.parent
    }
    return { kind: 'XPath', value: prefix + '/' + parts.join('/'), domCount: 1 }
  },
}

/** The page's own answer for the selected element: match counts of both locators and the element's current rect. */
export class LiveCheck {
  constructor(
    readonly cssCount: number | undefined,
    readonly cssError: string | undefined,
    readonly xpathCount: number | undefined,
    readonly xpathError: string | undefined,
    readonly rect: readonly number[] | undefined,
    readonly viewportWidth: number,
  ) {}

  /**
   * One script for the selected element: `querySelectorAll(css).length`, `document.evaluate(xpath)` snapshot length, and the rect of the
   * element found by following [path] (child indexes from `<html>`, the same as [DomNode.path]). Returns a JSON string.
   */
  static script(css: string, xpath: string, path: readonly number[]): string {
    return (
      `(function(){var o={};try{o.css=document.querySelectorAll(${JSON.stringify(css)}).length}catch(e){o.cssError=String(e&&e.message||e)}` +
      `try{o.xpath=document.evaluate(${JSON.stringify(xpath)},document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength}catch(e){o.xpathError=String(e&&e.message||e)}` +
      `var p=[${path.join(',')}],el=document.documentElement;for(var i=0;i<p.length&&el;i++){el=el.children[p[i]]}` +
      'if(el){var r=el.getBoundingClientRect();o.rect=[r.x,r.y,r.width,r.height]}o.vw=document.documentElement.getBoundingClientRect().width||innerWidth;return JSON.stringify(o)})()'
    )
  }

  static parse(stdout: string): LiveCheck {
    const data = MobilecliJson.data(stdout)
    if (data === undefined) throw new Error('The web view returned nothing')
    const o = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('The web view returned no object')
    const int = (k: string): number | undefined => (typeof o[k] === 'number' ? Math.trunc(o[k] as number) : undefined)
    const s = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
    const rect = Array.isArray(o.rect) && o.rect.length === 4 ? o.rect.map(Number) : undefined
    const cssError = s('cssError')
    const xpathError = s('xpathError')
    return new LiveCheck(int('css'), cssError === undefined ? undefined : WebViews.cleanError(cssError), int('xpath'), xpathError === undefined ? undefined : WebViews.cleanError(xpathError), rect, typeof o.vw === 'number' ? o.vw : 0.0)
  }
}

/** Text for the match count next to a locator: "1 match (unique)", "3 matches", "no match". */
export function matchText(count: number | undefined, error?: string): string {
  if (error !== undefined) return `invalid: ${error}`
  if (count === undefined) return 'not checked'
  if (count === 0) return 'no match'
  if (count === 1) return '1 match (unique)'
  return `${count} matches`
}
