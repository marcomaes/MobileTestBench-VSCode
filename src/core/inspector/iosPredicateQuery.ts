// ported-from: core/inspector/IosPredicateQuery.kt
import { KRegex } from '../javaRegex'
import { IllegalArgumentException, requireThat } from './illegalArgumentException'
import type { UiNode } from './uiNode'

export interface Predicate {
  test(node: UiNode): boolean
  /** Node attributes the predicate reads that a hierarchy dump may not provide (the boolean fields). */
  readonly required: ReadonlySet<string>
}

const NONE: ReadonlySet<string> = new Set()
const union = (parts: readonly Predicate[]): Set<string> => new Set(parts.flatMap((it) => [...it.required]))

const and = (parts: Predicate[]): Predicate => ({ test: (n) => parts.every((it) => it.test(n)), required: union(parts) })
const or = (parts: Predicate[]): Predicate => ({ test: (n) => parts.some((it) => it.test(n)), required: union(parts) })
const not = (part: Predicate): Predicate => ({ test: (n) => !part.test(n), required: part.required })
const constant = (value: boolean): Predicate => ({ test: () => value, required: NONE })
const cmp = (get: (n: UiNode) => string | undefined, needs: string | undefined, test: (v: string | undefined) => boolean): Predicate => ({
  test: (n) => test(get(n)),
  required: needs === undefined ? NONE : new Set([needs]),
})

const stringFields = new Map<string, (n: UiNode) => string | undefined>([
  ['type', (n) => n.rawType],
  ['name', (n) => n.attr('name')],
  ['identifier', (n) => n.attr('name')],
  ['label', (n) => n.attr('label')],
  ['value', (n) => n.attr('value')],
])
const booleanFields = new Set(['enabled', 'visible', 'accessible'])
const hasAttr = (n: UiNode, name: string): boolean => Object.prototype.hasOwnProperty.call(n.attributes, name)

/**
 * A subset of NSPredicate as used by the `-ios predicate string` strategy and inside class chains.
 * Fields: `type`, `name`, `label`, `value`, `identifier` (the same as `name`), and the booleans `enabled`, `visible`,
 * `accessible`. Operators: `==` `=` `!=` `<>` `CONTAINS` `BEGINSWITH` `ENDSWITH` `LIKE` (`*` and `?`) `MATCHES` (whole-string
 * regex) `IN {...}`, with the `[c]` and `[d]` modifiers, combined with `AND`/`&&`, `OR`/`||`, `NOT`/`!` and parentheses.
 */
export const IosPredicateQuery = {
  find(expression: string, root: UiNode): UiNode[] {
    requireThat(root.platform === 'IOS', '-ios predicate string needs an iOS screen, this one is Android')
    const predicate = IosPredicateQuery.parse(expression)
    const nodes = [...root.walk()]
    for (const attr of predicate.required) {
      requireThat(nodes.some((it) => hasAttr(it, attr)), `not supported yet: '${attr}' is not in this hierarchy dump`)
    }
    return nodes.filter((it) => !it.isRoot && predicate.test(it))
  },

  parse(expression: string): Predicate {
    const tokens = tokenize(expression)
    requireThat(tokens.length > 0, 'Empty predicate')
    const parser = new Parser(tokens)
    const result = parser.parseOr()
    requireThat(parser.atEnd, () => `not supported yet: ${parser.rest()} in the predicate`)
    return result
  },
}

// ---- tokens

type Tok = { kind: 'word'; text: string; upper: string } | { kind: 'str'; value: string } | { kind: 'num'; text: string } | { kind: 'sym'; text: string }

const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{Nd}/u.test(c)
const isLetter = (c: string): boolean => /\p{L}/u.test(c)
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c)

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === "'" || c === '"') {
      let sb = ''
      i++
      for (;;) {
        requireThat(i < s.length, 'Unterminated string in the predicate')
        const d = s[i]
        if (d === c) {
          i++
          break
        }
        if (d === '\\' && i + 1 < s.length) {
          const e = s[i + 1]
          sb += e === 'n' ? '\n' : e === 't' ? '\t' : e
          i += 2
        } else {
          sb += d
          i++
        }
      }
      out.push({ kind: 'str', value: sb })
    } else if (isDigit(c) || (c === '-' && isDigit(s[i + 1]))) {
      const start = i++
      while (i < s.length && (isDigit(s[i]) || s[i] === '.')) i++
      out.push({ kind: 'num', text: s.slice(start, i) })
    } else if (isLetter(c) || c === '_') {
      const start = i
      while (i < s.length && (isLetterOrDigit(s[i]) || s[i] === '_' || s[i] === '.')) i++
      const text = s.slice(start, i)
      out.push({ kind: 'word', text, upper: text.toUpperCase() })
    } else {
      const two = s.slice(i, Math.min(i + 2, s.length))
      if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ kind: 'sym', text: two })
        i += 2
      } else if ('=<>!(){},[]'.includes(c)) {
        out.push({ kind: 'sym', text: c })
        i++
      } else {
        throw new IllegalArgumentException(`not supported yet: '${c}' in the predicate`)
      }
    }
  }
  return out
}

const tokenText = (t: Tok): string => (t.kind === 'word' ? t.text : t.kind === 'str' ? `'${t.value}'` : t.kind === 'num' ? t.text : t.text)

const normalizeNfd = (v: string): string => v.normalize('NFD').replace(/\p{M}+/gu, '')

const escapeRegexChar = (ch: string): string => (/[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch)

class Parser {
  pos = 0
  constructor(private readonly tokens: Tok[]) {}

  get atEnd(): boolean {
    return this.pos >= this.tokens.length
  }

  rest(): string {
    return this.tokens.slice(this.pos).map(tokenText).join(' ')
  }

  private peek(): Tok | undefined {
    return this.tokens[this.pos]
  }
  private isWord(upper: string): boolean {
    const t = this.peek()
    return t?.kind === 'word' && t.upper === upper
  }
  private isSym(s: string): boolean {
    const t = this.peek()
    return t?.kind === 'sym' && t.text === s
  }

  parseOr(): Predicate {
    const parts = [this.parseAnd()]
    while (this.isWord('OR') || this.isSym('||')) {
      this.pos++
      parts.push(this.parseAnd())
    }
    return parts.length === 1 ? parts[0] : or(parts)
  }

  private parseAnd(): Predicate {
    const parts = [this.parseNot()]
    while (this.isWord('AND') || this.isSym('&&')) {
      this.pos++
      parts.push(this.parseNot())
    }
    return parts.length === 1 ? parts[0] : and(parts)
  }

  private parseNot(): Predicate {
    if (this.isWord('NOT') || this.isSym('!')) {
      this.pos++
      return not(this.parseNot())
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Predicate {
    if (this.isSym('(')) {
      this.pos++
      const inner = this.parseOr()
      requireThat(this.isSym(')'), 'Missing closing parenthesis in the predicate')
      this.pos++
      return inner
    }
    if (this.isWord('TRUEPREDICATE')) {
      this.pos++
      return constant(true)
    }
    if (this.isWord('FALSEPREDICATE')) {
      this.pos++
      return constant(false)
    }
    return this.parseComparison()
  }

  private parseComparison(): Predicate {
    const left = this.peek()
    if (left === undefined) throw new IllegalArgumentException('The predicate ends too early')
    if (left.kind !== 'word') throw new IllegalArgumentException(`not supported yet: ${tokenText(left)} on the left of a comparison, write the field first`)
    this.pos++
    const field = left.text
    const isBool = booleanFields.has(field)
    const getString = stringFields.get(field)
    if (!isBool && getString === undefined) {
      throw new IllegalArgumentException(`not supported yet: predicate field '${field}' (supported: ${[...stringFields.keys(), ...booleanFields].join(', ')})`)
    }
    const op = this.operator()
    let ci = ''
    if (this.isSym('[')) {
      this.pos++
      const t = this.peek()
      if (t?.kind !== 'word') throw new IllegalArgumentException('Expected a modifier like [c] after the operator')
      const mod = t.text
      this.pos++
      requireThat(this.isSym(']'), 'Missing ] after the modifier')
      this.pos++
      requireThat([...mod].every((it) => it === 'c' || it === 'd'), `not supported yet: the modifier [${mod}]`)
      ci += mod
    }
    const caseInsensitive = ci.includes('c')
    const noDiacritics = ci.includes('d')
    const norm = (v: string): string => {
      let r = v
      if (noDiacritics) r = normalizeNfd(r)
      if (caseInsensitive) r = r.toLowerCase()
      return r
    }

    if (isBool) {
      requireThat(op === '==' || op === '!=', `not supported yet: ${op} on the boolean field '${field}'`)
      const want = this.booleanLiteral(field)
      return cmp((n) => n.attributes[field], field, (raw) => ((raw === 'true') === want) === (op === '=='))
    }
    const get = getString!
    if (op === 'IN') {
      const values = this.listLiteral(field).map(norm)
      return cmp(get, undefined, (v) => v !== undefined && values.includes(norm(v)))
    }
    const literal = this.peek()
    this.pos++
    if (literal?.kind === 'word' && (literal.upper === 'NIL' || literal.upper === 'NULL')) {
      requireThat(op === '==' || op === '!=', `not supported yet: ${op} with nil`)
      return cmp(get, undefined, (v) => (v === undefined) === (op === '=='))
    }
    let value: string
    if (literal?.kind === 'str') value = literal.value
    else if (literal?.kind === 'num' || literal?.kind === 'word') throw new IllegalArgumentException(`not supported yet: ${tokenText(literal)} for '${field}', compare it with a quoted string`)
    else throw new IllegalArgumentException(`Expected a quoted string after ${op}`)
    const wanted = norm(value)
    let test: (v: string) => boolean
    switch (op) {
      case '==':
      case '!=':
        test = (v) => norm(v) === wanted
        break
      case 'CONTAINS':
        test = (v) => norm(v).includes(wanted)
        break
      case 'BEGINSWITH':
        test = (v) => norm(v).startsWith(wanted)
        break
      case 'ENDSWITH':
        test = (v) => norm(v).endsWith(wanted)
        break
      case 'LIKE': {
        // Kotlin: Regex(likeToRegex(wanted), DOT_MATCHES_ALL).matches(...)
        const source = [...wanted].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegexChar(ch))).join('')
        const regex = new RegExp(`^(?:${source})$`, 'su')
        test = (v) => regex.test(norm(v))
        break
      }
      case 'MATCHES': {
        let regex: KRegex
        try {
          regex = new KRegex(value, { ignoreCase: caseInsensitive })
        } catch (e) {
          throw new IllegalArgumentException(`Invalid regex in the predicate: ${((e as Error).message ?? '').split('\n')[0]}`)
        }
        test = (v) => regex.matches(v)
        break
      }
      default:
        throw new IllegalArgumentException(`not supported yet: ${op}`)
    }
    return op === '!=' ? cmp(get, undefined, (v) => v === undefined || !test(v)) : cmp(get, undefined, (v) => v !== undefined && test(v))
  }

  private operator(): string {
    const t = this.peek()
    if (t === undefined) throw new IllegalArgumentException('The predicate ends after a field name')
    this.pos++
    if (t.kind === 'sym') {
      if (t.text === '==' || t.text === '=') return '=='
      if (t.text === '!=' || t.text === '<>') return '!='
      throw new IllegalArgumentException(`not supported yet: the operator ${t.text}`)
    }
    if (t.kind === 'word' && ['CONTAINS', 'BEGINSWITH', 'ENDSWITH', 'LIKE', 'MATCHES', 'IN'].includes(t.upper)) return t.upper
    if (t.kind === 'word' && t.upper === 'NOT') throw new IllegalArgumentException('not supported yet: NOT after a field, write NOT (field LIKE ...)')
    throw new IllegalArgumentException(`not supported yet: the operator ${tokenText(t)}`)
  }

  private booleanLiteral(field: string): boolean {
    const t = this.peek()
    if (t === undefined) throw new IllegalArgumentException(`The predicate ends after ${field} ==`)
    this.pos++
    if (t.kind === 'word' && (t.upper === 'TRUE' || t.upper === 'YES')) return true
    if (t.kind === 'word' && (t.upper === 'FALSE' || t.upper === 'NO')) return false
    if (t.kind === 'num' && t.text === '1') return true
    if (t.kind === 'num' && t.text === '0') return false
    throw new IllegalArgumentException(`'${field}' is a boolean, compare it with true or false`)
  }

  private listLiteral(field: string): string[] {
    const t = this.peek()
    const open = t?.kind === 'sym' ? t.text : undefined
    requireThat(open === '{' || open === '(', 'Expected { after IN')
    this.pos++
    const close = open === '{' ? '}' : ')'
    const values: string[] = []
    for (;;) {
      const v = this.peek()
      if (v?.kind !== 'str') throw new IllegalArgumentException(`not supported yet: IN lists other than quoted strings for '${field}'`)
      values.push(v.value)
      this.pos++
      if (this.isSym(',')) {
        this.pos++
        continue
      }
      requireThat(this.isSym(close), `Missing ${close} after the IN list`)
      this.pos++
      return values
    }
  }
}
