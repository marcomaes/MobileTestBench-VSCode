// No Kotlin counterpart: Kotlin's Regex is java.util.regex, JavaScript's RegExp is not. This translates the Java
// features that user typed patterns plausibly use (leading (?i)/(?s)/(?m), \Q..\E, possessive quantifiers, atomic
// groups, \A \z \Z, \h, POSIX \p{Alpha}) so the same pattern matches the same text.

export interface JavaRegexOptions {
  readonly ignoreCase?: boolean
  readonly dotAll?: boolean
}

const POSIX: Record<string, string> = {
  Lower: 'a-z',
  Upper: 'A-Z',
  ASCII: '\\x00-\\x7F',
  Alpha: 'a-zA-Z',
  Digit: '0-9',
  Alnum: 'a-zA-Z0-9',
  Punct: '!-\\/:-@\\[-`{-~',
  Graph: '!-~',
  Print: ' -~',
  Blank: ' \\t',
  Cntrl: '\\x00-\\x1F\\x7F',
  XDigit: '0-9a-fA-F',
  Space: ' \\t\\n\\x0B\\f\\r',
}
const HSPACE = ' \\t\\xA0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000'
const U_SYNTAX = '^$\\.*+?()[]{}|/'

const escapeChar = (c: string): string => (/[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c)

/** Translates a Java regex into JS source and flags. Throws a SyntaxError for patterns JS cannot express. */
export function translateJavaRegex(pattern: string, options: JavaRegexOptions = {}): { source: string; flags: string } {
  const flags = new Set<string>()
  if (options.ignoreCase) flags.add('i')
  if (options.dotAll) flags.add('s')
  let p = pattern
  const lead = /^\(\?([imsxuU]+)\)/.exec(p)
  if (lead) {
    for (const f of lead[1]) if (f === 'i' || f === 's' || f === 'm') flags.add(f)
    p = p.slice(lead[0].length)
  }
  const unicode = /\\[pP]\{/.test(p)
  if (unicode) flags.add('u')
  let out = ''
  let inClass = false
  let prevQuantifier = false
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') {
      const n = p[i + 1]
      if (n === undefined) throw new SyntaxError('Unexpected internal error near index ' + i)
      prevQuantifier = false
      if (n === 'Q') {
        const end = p.indexOf('\\E', i + 2)
        const literal = end < 0 ? p.slice(i + 2) : p.slice(i + 2, end)
        for (const ch of literal) out += inClass ? (/[\\\]^-]/.test(ch) ? `\\${ch}` : ch) : escapeChar(ch)
        i = end < 0 ? p.length : end + 1
        continue
      }
      if (n === 'E') {
        i++
        continue
      }
      if (!inClass && n === 'A') out += '(?<![\\s\\S])'
      else if (!inClass && n === 'z') out += '(?![\\s\\S])'
      else if (!inClass && n === 'Z') out += '(?=\\n?(?![\\s\\S]))'
      else if (n === 'h') out += inClass ? HSPACE : `[${HSPACE}]`
      else if ((n === 'p' || n === 'P') && p[i + 2] === '{') {
        const close = p.indexOf('}', i + 3)
        if (close < 0) throw new SyntaxError('Unclosed character family near index ' + i)
        const name = p.slice(i + 3, close).replace(/^Is/, '')
        const posix = POSIX[name]
        if (posix !== undefined) out += n === 'p' ? (inClass ? posix : `[${posix}]`) : `[^${posix}]`
        else out += `\\${n}{${name}}`
        i = close
        continue
      } else if (unicode && !/[a-zA-Z0-9]/.test(n) && !U_SYNTAX.includes(n) && !(inClass && n === '-')) out += n
      else out += `\\${n}`
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      else if (c === '[' ) { out += '\\['; continue }
      out += c
      continue
    }
    if (c === '[') {
      inClass = true
      prevQuantifier = false
      out += c
      if (p[i + 1] === '^') { out += '^'; i++ }
      if (p[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === '(' && p[i + 1] === '?') {
      prevQuantifier = false
      if (p[i + 2] === '>') { out += '(?:'; i += 2; continue }
      out += '(?'
      i++
      continue
    }
    if ((c === '+') && prevQuantifier) { prevQuantifier = false; continue } // possessive: greedy is the nearest JS equivalent
    if (c === '*' || c === '+' || c === '?') {
      // `?` right after a quantifier makes it lazy and is kept; a quantifier may only be lazy once.
      if (c === '?' && prevQuantifier) { out += c; prevQuantifier = false; continue }
      prevQuantifier = true
      out += c
      continue
    }
    if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(p.slice(i))
      if (m) { out += m[0]; i += m[0].length - 1; prevQuantifier = true; continue }
    }
    prevQuantifier = false
    out += c
  }
  return { source: out, flags: [...flags].join('') }
}

/** Kotlin `Regex`: `containsMatchIn` and `matches` (the whole input) on a Java pattern. */
export class KRegex {
  private readonly search: RegExp
  private readonly whole: RegExp

  constructor(readonly pattern: string, options: JavaRegexOptions = {}) {
    const { source, flags } = translateJavaRegex(pattern, options)
    this.search = new RegExp(source, flags)
    this.whole = new RegExp(`^(?:${source})$`, flags)
  }

  containsMatchIn(input: string): boolean {
    return this.search.test(input)
  }

  /** Kotlin `matches(input)`: true when the entire input matches. */
  matches(input: string): boolean {
    return this.whole.test(input)
  }
}
