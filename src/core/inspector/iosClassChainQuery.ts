// ported-from: core/inspector/IosClassChainQuery.kt
import { IllegalArgumentException, requireThat } from './illegalArgumentException'
import { IosPredicateQuery, type Predicate } from './iosPredicateQuery'
import type { UiNode } from './uiNode'

type Filter = { kind: 'predicate'; predicate: Predicate } | { kind: 'index'; index: number }
interface Segment {
  readonly type: string
  readonly filters: Filter[]
}

/**
 * A subset of the XCUITest class chain (`-ios class chain`): segments separated by `/`, each a type
 * (`XCUIElementTypeButton`, or `*` for any), `**` for "any depth below", and per segment any number of `[...]` filters
 * applied in order: ``[`predicate`]`` (see [IosPredicateQuery]) or `[n]` (1-based position among the elements found
 * below the current element so far; `-1` is the last). The search starts below the application element.
 * The `$predicate$` descendant condition is refused as not supported yet.
 */
export const IosClassChainQuery = {
  find(expression: string, root: UiNode): UiNode[] {
    requireThat(root.platform === 'IOS', '-ios class chain needs an iOS screen, this one is Android')
    const segments = parse(expression)
    let contexts: UiNode[] = [root]
    let deep = false
    for (const segment of segments) {
      if (segment.type === '**') {
        deep = true
        continue
      }
      const next = new Set<UiNode>()
      for (const context of contexts) {
        let candidates = (deep ? [...context.walk()].filter((it) => it !== context) : [...context.children]).filter((it) => segment.type === '*' || it.rawType === segment.type)
        for (const filter of segment.filters) {
          if (filter.kind === 'predicate') {
            candidates = candidates.filter((it) => filter.predicate.test(it))
          } else {
            const at = filter.index > 0 ? filter.index - 1 : candidates.length + filter.index
            const item = at >= 0 ? candidates[at] : undefined
            candidates = item !== undefined ? [item] : []
          }
        }
        for (const c of candidates) next.add(c)
      }
      deep = false
      contexts = [...next]
      if (contexts.length === 0) return []
    }
    return contexts
  },
}

function parse(expression: string): Segment[] {
  const text = expression.trim()
  requireThat(text.length > 0, 'Empty class chain')
  const segments = split(text).map(parseSegment)
  requireThat(segments[segments.length - 1].type !== '**', 'A class chain cannot end with **, name the element type after it')
  return segments
}

/** Splits at `/` outside backticks and brackets. */
function split(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let inTick = false
  let depth = 0
  for (const c of text) {
    if (c === '`') {
      inTick = !inTick
      current += c
    } else if (inTick) current += c
    else if (c === '[') {
      depth++
      current += c
    } else if (c === ']') {
      depth--
      current += c
    } else if (c === '/' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += c
  }
  requireThat(!inTick, 'Unbalanced backtick in the class chain')
  parts.push(current)
  requireThat(parts.every((it) => it.trim().length > 0), 'Empty segment in the class chain (a leading, trailing or doubled /)')
  return parts
}

function parseSegment(raw: string): Segment {
  const part = raw.trim()
  const bracket = part.indexOf('[')
  const type = (bracket < 0 ? part : part.slice(0, bracket)).trim()
  requireThat(type === '**' || type === '*' || /^XCUIElementType\w+$/.test(type), `Unknown element type '${type}' in the class chain (expected XCUIElementTypeX, * or **)`)
  if (bracket < 0) return { type, filters: [] }
  requireThat(type !== '**', 'not supported yet: a filter on **')
  const filters: Filter[] = []
  let i = bracket
  while (i < part.length) {
    requireThat(part[i] === '[', () => `Unexpected '${part.slice(i).slice(0, 20)}' in the class chain`)
    const close = closingBracket(part, i)
    const body = part.slice(i + 1, close).trim()
    if (body.startsWith('`') && body.endsWith('`') && body.length >= 2) {
      filters.push({ kind: 'predicate', predicate: IosPredicateQuery.parse(body.slice(1, body.length - 1)) })
    } else if (body.startsWith('$')) {
      throw new IllegalArgumentException(`not supported yet: the class chain condition ${body}`)
    } else {
      const n = /^[+-]?\d+$/.test(body) ? parseInt(body, 10) : undefined
      if (n === undefined || n === 0) throw new IllegalArgumentException(`not supported yet: [${body}] in a class chain (expected [n], [-1] or [\`predicate\`])`)
      filters.push({ kind: 'index', index: n })
    }
    i = close + 1
    while (i < part.length && /\s/.test(part[i])) i++
  }
  return { type, filters }
}

function closingBracket(part: string, open: number): number {
  let inTick = false
  let quote: string | undefined
  for (let i = open + 1; i < part.length; i++) {
    const c = part[i]
    if (quote !== undefined) {
      if (c === quote) quote = undefined
    } else if (c === "'" || c === '"') quote = c
    else if (c === '`') inTick = !inTick
    else if (c === ']' && !inTick) return i
  }
  throw new IllegalArgumentException('Missing ] in the class chain')
}
