// ported-from: core/inspector/UiSelectorQuery.kt
import { KRegex } from '../javaRegex'
import { Cursor } from './appiumSyntax'
import { IllegalArgumentException, requireThat } from './illegalArgumentException'
import type { UiNode } from './uiNode'

type Condition = (n: UiNode) => boolean

interface Spec {
  readonly conditions: Map<string, Condition>
  readonly instance?: number
  readonly child?: Spec
  readonly required: ReadonlySet<string>
}

const allRequired = (spec: Spec): Set<string> => new Set([...spec.required, ...(spec.child ? allRequired(spec.child) : [])])

/** The real UiSelector string methods; UiSelector has no classNameContains, resourceIdStartsWith and so on. */
const stringMethods = new Map<string, [string, string | undefined]>([
  ['text', ['text', undefined]], ['textContains', ['text', 'Contains']],
  ['textStartsWith', ['text', 'StartsWith']], ['textMatches', ['text', 'Matches']],
  ['description', ['description', undefined]], ['descriptionContains', ['description', 'Contains']],
  ['descriptionStartsWith', ['description', 'StartsWith']], ['descriptionMatches', ['description', 'Matches']],
  ['className', ['className', undefined]], ['classNameMatches', ['className', 'Matches']],
  ['resourceId', ['resourceId', undefined]], ['resourceIdMatches', ['resourceId', 'Matches']],
  ['packageName', ['packageName', undefined]], ['packageNameMatches', ['packageName', 'Matches']],
])

const stringAttributes = new Map<string, (n: UiNode) => string>([
  ['text', (n) => n.attributes['text'] ?? ''],
  ['description', (n) => n.attributes['content-desc'] ?? ''],
  ['className', (n) => n.rawType],
  ['resourceId', (n) => n.attributes['resource-id'] ?? ''],
  ['packageName', (n) => n.attributes['package'] ?? ''],
])

const booleanAttributes = new Map<string, string>([
  ['clickable', 'clickable'], ['checkable', 'checkable'], ['checked', 'checked'], ['enabled', 'enabled'],
  ['focusable', 'focusable'], ['focused', 'focused'], ['longClickable', 'long-clickable'],
  ['scrollable', 'scrollable'], ['selected', 'selected'],
])

const hasAttr = (n: UiNode, name: string): boolean => Object.prototype.hasOwnProperty.call(n.attributes, name)

/**
 * Evaluates an Android `UiSelector` expression (the value of the `-android uiautomator` strategy) against a hierarchy.
 *
 * Supported: `resourceId`, `resourceIdMatches`, `text`, `textContains`, `textStartsWith`, `textMatches`, `description`,
 * `descriptionContains`, `descriptionStartsWith`, `descriptionMatches`, `className`, `classNameMatches`, `packageName`,
 * `packageNameMatches`, the booleans `clickable`, `checkable`, `checked`, `enabled`, `focusable`, `focused`,
 * `longClickable`, `scrollable`, `selected`, `index(n)` (position among the siblings, from 0), `instance(n)` (the n-th
 * match in document order, from 0) and `childSelector(...)` (a matching descendant). `...Matches` are whole-string regexes.
 * Anything else (`fromParent`, `UiScrollable`) is refused with a "not supported yet" message.
 */
export const UiSelectorQuery = {
  find(expression: string, root: UiNode): UiNode[] {
    requireThat(root.platform === 'ANDROID', '-android uiautomator needs an Android screen, this one is iOS')
    const cursor = new Cursor(trimEndSemicolons(expression.trim()))
    const spec = parseSelector(cursor)
    cursor.requireEnd()
    const nodes = [...root.walk()]
    for (const attr of allRequired(spec)) {
      requireThat(nodes.some((it) => hasAttr(it, attr)), `not supported yet: '${attr}' is not in this hierarchy dump`)
    }
    return evaluate(spec, nodes.filter((it) => !it.isRoot))
  },
}

const trimEndSemicolons = (s: string): string => s.replace(/;+$/, '')

function evaluate(spec: Spec, scope: UiNode[]): UiNode[] {
  let matches = scope.filter((n) => [...spec.conditions.values()].every((c) => c(n)))
  if (spec.instance !== undefined) {
    const item = matches[spec.instance]
    matches = spec.instance >= 0 && item !== undefined ? [item] : []
  }
  if (!spec.child) return matches
  const result = new Set<UiNode>()
  for (const n of matches) for (const m of evaluate(spec.child, [...n.walk()].filter((it) => it !== n))) result.add(m)
  return [...result]
}

function parseSelector(c: Cursor): Spec {
  c.skipWhitespace()
  const save = c.i
  let word = c.identifier()
  if (word === 'new') word = c.identifier()
  if (word === 'UiScrollable' || word === 'UiCollection') throw new IllegalArgumentException(`not supported yet: ${word}`)
  requireThat(word === 'UiSelector', () => `Expected new UiSelector()... at: ${c.text.slice(save).slice(0, 30)}`)
  c.expect('(')
  c.expect(')')
  const conditions = new Map<string, Condition>()
  let instance: number | undefined
  let child: Spec | undefined
  const required = new Set<string>()
  while (c.eat('.')) {
    const method = c.identifier()
    if (method === undefined) throw new IllegalArgumentException("Expected a method name after '.'")
    c.expect('(')
    if (method === 'instance') {
      instance = integer(c, method)
    } else if (method === 'index') {
      const n = integer(c, method)
      conditions.set(method, (it) => it.parent?.children.indexOf(it) === n)
    } else if (method === 'childSelector') {
      child = parseSelector(c)
    } else if (method === 'fromParent') {
      throw new IllegalArgumentException('not supported yet: UiSelector.fromParent(...)')
    } else if (booleanAttributes.has(method)) {
      const word2 = c.identifier()
      if (word2 !== 'true' && word2 !== 'false') throw new IllegalArgumentException(`${method}() takes true or false`)
      const flag = word2 === 'true'
      const attr = booleanAttributes.get(method)!
      required.add(attr)
      conditions.set(method, (it) => (it.attributes[attr] === 'true') === flag)
    } else {
      if (method.startsWith('packageName')) required.add('package')
      conditions.set(method, stringCondition(method, c.literal()))
    }
    c.expect(')')
  }
  return { conditions, instance, child, required }
}

function integer(c: Cursor, method: string): number {
  c.skipWhitespace()
  const start = c.i
  if (c.text[c.i] === '-') c.i++
  while (c.i < c.text.length && /\p{Nd}/u.test(c.text[c.i])) c.i++
  const text = c.text.slice(start, c.i)
  if (!/^-?\d+$/.test(text)) throw new IllegalArgumentException(`${method}() takes a number`)
  return parseInt(text, 10)
}

function stringCondition(method: string, value: string): Condition {
  const entry = stringMethods.get(method)
  if (!entry) throw new IllegalArgumentException(`not supported yet: UiSelector.${method}(...)`)
  const [base, suffix] = entry
  const get = stringAttributes.get(base)!
  switch (suffix) {
    case undefined:
      return (n) => get(n) === value
    case 'Contains':
      return (n) => get(n).includes(value)
    case 'StartsWith':
      return (n) => get(n).startsWith(value)
    default: {
      let regex: KRegex
      try {
        regex = new KRegex(value)
      } catch (e) {
        throw new IllegalArgumentException(`Invalid regex in ${method}(): ${((e as Error).message ?? '').split('\n')[0]}`)
      }
      return (n) => regex.matches(get(n))
    }
  }
}
