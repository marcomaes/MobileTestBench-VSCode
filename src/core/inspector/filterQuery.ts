// ported-from: core/inspector/FilterQuery.kt
import { KRegex } from '../javaRegex'
import { AccessibilityAudit } from './accessibilityAudit'
import type { UiNode } from './uiNode'

export interface Operator {
  readonly name: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS'
  readonly symbol: string
}

/** One `key=value`, `key!=value` or `key~value` term of the element filter. */
export class AttributeTerm {
  static readonly Operator = {
    EQUALS: Object.freeze({ name: 'EQUALS', symbol: '=' }) as Operator,
    NOT_EQUALS: Object.freeze({ name: 'NOT_EQUALS', symbol: '!=' }) as Operator,
    CONTAINS: Object.freeze({ name: 'CONTAINS', symbol: '~' }) as Operator,
  }

  constructor(
    readonly key: string,
    readonly operator: Operator,
    readonly value: string,
  ) {}

  toString(): string {
    return this.key + this.operator.symbol + this.value
  }
}

/** A term that looks like an attribute term but cannot be applied. */
export interface InvalidTerm {
  readonly text: string
  readonly reason: string
}

/**
 * One group of the filter: every part must hold. The plain parts ([freeText], [terms]) must match; the
 * `not` parts (words written with a leading `-` or `!`) must not. [regexes] come from `/pattern/` words.
 */
export class FilterGroup {
  constructor(
    readonly freeText: string,
    readonly terms: readonly AttributeTerm[],
    readonly notTerms: readonly AttributeTerm[] = [],
    readonly notFree: readonly string[] = [],
    readonly regexes: readonly KRegex[] = [],
    readonly notRegexes: readonly KRegex[] = [],
  ) {}

  get isEmpty(): boolean {
    return this.freeText.length === 0 && this.terms.length === 0 && this.notTerms.length === 0 && this.notFree.length === 0 && this.regexes.length === 0 && this.notRegexes.length === 0
  }
}

class Token {
  constructor(
    readonly raw: string,
    readonly text: string,
    readonly firstQuote: number,
    readonly unterminatedQuote: boolean,
  ) {}

  withoutFirstChar(): Token {
    return new Token(this.raw.slice(1), this.text.slice(1), this.firstQuote > 0 ? this.firstQuote - 1 : this.firstQuote, this.unterminatedQuote)
  }
}

type Parsed = { kind: 'free'; text: string } | { kind: 'term'; term: AttributeTerm } | { kind: 're'; regex: KRegex } | { kind: 'bad'; reason: string }

const keyPattern = /^[A-Za-z0-9_.:-]+$/

/**
 * The text of the filter field, split into groups of free text and attribute terms.
 * Terms are separated by spaces; a value with spaces is written in double quotes (`text="Log in"`).
 * Every other word is free text; the free words are joined again with single spaces.
 * A leading `-` or `!` negates a word (`-error`, `-clickable=true`), `/pattern/` is a case-insensitive
 * regular expression, and the words `OR` or `|` start a new group: an element matches when any group does.
 */
export class FilterQuery {
  static readonly EMPTY = new FilterQuery([], [])

  constructor(
    readonly groups: readonly FilterGroup[],
    readonly invalid: readonly InvalidTerm[],
  ) {}

  /** Free text of the first group; the whole query when there is no `OR`. */
  get freeText(): string {
    return this.groups[0]?.freeText ?? ''
  }

  /** Attribute terms of the first group; the whole query when there is no `OR`. */
  get terms(): readonly AttributeTerm[] {
    return this.groups[0]?.terms ?? []
  }

  get isEmpty(): boolean {
    return this.groups.length === 0
  }

  static parse(input: string): FilterQuery {
    const groups: FilterGroup[] = []
    let free: string[] = []
    let notFree: string[] = []
    let terms: AttributeTerm[] = []
    let notTerms: AttributeTerm[] = []
    let regexes: KRegex[] = []
    let notRegexes: KRegex[] = []
    const invalid: InvalidTerm[] = []
    const closeGroup = (): void => {
      const group = new FilterGroup(free.join(' '), terms, notTerms, notFree, regexes, notRegexes)
      if (!group.isEmpty) groups.push(group)
      free = []
      notFree = []
      terms = []
      notTerms = []
      regexes = []
      notRegexes = []
    }
    for (const token of tokenize(input)) {
      if (token.raw === 'OR' || token.raw === '|') {
        closeGroup()
        continue
      }
      if (token.unterminatedQuote) {
        invalid.push({ text: token.raw, reason: 'unterminated quote' })
        continue
      }
      const negated = token.raw.length > 1 && (token.raw[0] === '-' || token.raw[0] === '!') && token.raw[1] !== '='
      const body = negated ? token.withoutFirstChar() : token
      const parsed = parseToken(body)
      switch (parsed.kind) {
        case 'free':
          if (parsed.text.length > 0) (negated ? notFree : free).push(parsed.text)
          break
        case 'term':
          ;(negated ? notTerms : terms).push(parsed.term)
          break
        case 're':
          ;(negated ? notRegexes : regexes).push(parsed.regex)
          break
        case 'bad':
          invalid.push({ text: token.raw, reason: parsed.reason })
          break
      }
    }
    closeGroup()
    return new FilterQuery(groups, invalid)
  }

  static isBoolean(key: string): boolean {
    return AttributeMatcher.BOOLEAN_KEYS.has(key.toLowerCase())
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let raw = ''
  let text = ''
  let firstQuote = -1
  let inQuote = false
  const flush = (): void => {
    if (raw.length > 0) tokens.push(new Token(raw, text, firstQuote, inQuote))
    raw = ''
    text = ''
    firstQuote = -1
    inQuote = false
  }
  for (const c of input) {
    if (c === '"') {
      if (!inQuote && firstQuote < 0) firstQuote = text.length
      inQuote = !inQuote
      raw += c
    } else if (/\s/.test(c) && !inQuote) {
      flush()
    } else {
      raw += c
      text += c
    }
  }
  flush()
  return tokens
}

function parseToken(token: Token): Parsed {
  if (token.text.length >= 3 && token.text.startsWith('/') && token.text.endsWith('/')) {
    try {
      return { kind: 're', regex: new KRegex(token.text.slice(1, token.text.length - 1), { ignoreCase: true }) }
    } catch {
      return { kind: 'bad', reason: 'invalid regular expression' }
    }
  }
  const head = token.firstQuote >= 0 ? token.text.slice(0, token.firstQuote) : token.text
  const at = findOperator(head)
  if (at < 0) return { kind: 'free', text: token.text }
  const op = head[at] === '~' ? AttributeTerm.Operator.CONTAINS : head[at] === '!' ? AttributeTerm.Operator.NOT_EQUALS : AttributeTerm.Operator.EQUALS
  const key = head.slice(0, at)
  const value = token.text.slice(at + op.symbol.length)
  if (key.length === 0) return { kind: 'bad', reason: `missing attribute name before ${op.symbol}` }
  if (!keyPattern.test(key)) return { kind: 'free', text: token.text }
  if (FilterQuery.isBoolean(key)) {
    if (op === AttributeTerm.Operator.CONTAINS) return { kind: 'bad', reason: `${key} takes = or !=, not ~` }
    if (!['true', 'false'].includes(value.toLowerCase())) return { kind: 'bad', reason: `${key} must be true or false` }
  }
  return { kind: 'term', term: new AttributeTerm(key, op, value) }
}

/** Index of the first operator in [head]: `=`, `~`, or `!` directly followed by `=`; -1 when there is none. */
function findOperator(head: string): number {
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '=' || head[i] === '~') return i
    if (head[i] === '!' && head[i + 1] === '=') return i
  }
  return -1
}

const equalsIgnoreCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const containsIgnoreCase = (a: string, b: string): boolean => a.toLowerCase().includes(b.toLowerCase())

/** Resolves attribute terms against a [UiNode]; aliases work on both platforms. */
export const AttributeMatcher = {
  /** Keys that hold true/false. Missing attributes count as false. */
  BOOLEAN_KEYS: new Set(['enabled', 'clickable', 'focused', 'checked', 'selected', 'visible', 'interactive', 'checkable', 'focusable', 'scrollable', 'password', 'long-clickable']) as ReadonlySet<string>,

  /** The values the key stands for on this node (a missing attribute gives an empty list). */
  valuesOf(node: UiNode, key: string): string[] {
    const k = key.toLowerCase()
    if (k === 'visible') return [String(node.isVisible)]
    if (k === 'interactive') return [String(AccessibilityAudit.isInteractive(node))]
    if (k === 'clickable' && node.platform === 'IOS') return [String(AccessibilityAudit.isInteractive(node))]
    if (AttributeMatcher.BOOLEAN_KEYS.has(k)) return [(node.attr(k) ?? 'false').toLowerCase()]
    if (k === 'type' || k === 'class') return [node.type, node.rawType]
    if (['id', 'identifier', 'resource-id', 'resourceid'].includes(k)) {
      const rid = node.resourceId
      return [node.identifier, rid, rid === undefined ? undefined : rid.includes(':id/') ? rid.slice(rid.indexOf(':id/') + 4) : rid].filter((it): it is string => it !== undefined)
    }
    if (['label', 'text', 'content-desc', 'contentdesc', 'desc', 'value'].includes(k)) {
      return [node.label, node.text, node.value].filter((it): it is string => it !== undefined)
    }
    const entry = Object.entries(node.attributes).find(([name]) => equalsIgnoreCase(name, key))
    return entry !== undefined && entry[1] !== '' ? [entry[1]] : []
  },

  matches(node: UiNode, term: AttributeTerm): boolean {
    const values = AttributeMatcher.valuesOf(node, term.key)
    switch (term.operator) {
      case AttributeTerm.Operator.EQUALS:
        return term.value.length === 0 ? values.length === 0 : values.some((it) => equalsIgnoreCase(it, term.value))
      case AttributeTerm.Operator.NOT_EQUALS:
        return term.value.length === 0 ? values.length > 0 : !values.some((it) => equalsIgnoreCase(it, term.value))
      default:
        return values.some((it) => containsIgnoreCase(it, term.value))
    }
  },
}

