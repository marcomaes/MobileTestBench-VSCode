// ported-from: core/inspector/AppiumSyntax.kt
import { IllegalArgumentException, requireThat } from './illegalArgumentException'

const isWhitespace = (c: string): boolean => /\s/.test(c)
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c)

/** A tiny scanner over a locator expression: whitespace, single characters and quoted string literals of Java, Kotlin, Python and C#. */
export class Cursor {
  constructor(
    readonly text: string,
    public i: number = 0,
  ) {}

  get atEnd(): boolean {
    return this.i >= this.text.length
  }

  skipWhitespace(): void {
    while (this.i < this.text.length && isWhitespace(this.text[this.i])) this.i++
  }

  peek(): string | undefined {
    this.skipWhitespace()
    return this.text[this.i]
  }

  eat(c: string): boolean {
    if (this.peek() !== c) return false
    this.i++
    return true
  }

  expect(c: string): void {
    requireThat(this.eat(c), () => `Expected '${c}' at: ${this.rest().slice(0, 30)}`)
  }

  rest(): string {
    return this.text.slice(Math.min(this.i, this.text.length)).trim()
  }

  /** An identifier (letters, digits, `_`), or undefined when none follows. */
  identifier(): string | undefined {
    this.skipWhitespace()
    const start = this.i
    while (this.i < this.text.length && (isLetterOrDigit(this.text[this.i]) || this.text[this.i] === '_')) this.i++
    return this.i > start ? this.text.slice(start, this.i) : undefined
  }

  requireEnd(): void {
    this.skipWhitespace()
    requireThat(this.atEnd, () => `not supported yet: ${this.rest().slice(0, 40)}`)
  }

  /**
   * A quoted string: `"..."` or `'...'` with backslash escapes (Java, Kotlin, Python), Python raw `r"..."`,
   * triple quoted `"""..."""`, and C# verbatim `@"..."` (where `""` is a quote). String interpolation is refused.
   */
  literal(): string {
    this.skipWhitespace()
    let raw = false
    let verbatim = false
    const first = this.text[this.i]
    const second = this.text[this.i + 1]
    if (second === '"' || second === "'") {
      if (first === 'r' || first === 'R') {
        raw = true
        this.i++
      } else if (first === '@') {
        verbatim = true
        this.i++
      } else if (first === '$' || first === 'f' || first === 'F') {
        throw new IllegalArgumentException('not supported yet: an interpolated string, write the value out')
      }
    }
    const quote = this.text[this.i]
    requireThat(quote === '"' || quote === "'", () => `Expected a quoted string at: ${this.rest().slice(0, 30)}`)
    const triple = quote + quote + quote
    if (this.text.startsWith(triple, this.i)) {
      const end = this.text.indexOf(triple, this.i + 3)
      requireThat(end >= 0, 'Unterminated string')
      const value = this.text.slice(this.i + 3, end)
      this.i = end + 3
      return value
    }
    this.i++
    let out = ''
    for (;;) {
      requireThat(this.i < this.text.length, 'Unterminated string')
      const c = this.text[this.i]
      if (c === quote && verbatim && this.text[this.i + 1] === quote) {
        out += quote
        this.i += 2
      } else if (c === quote) {
        this.i++
        return out
      } else if (c === '\\' && !raw && !verbatim) {
        requireThat(this.i + 1 < this.text.length, 'Unterminated string')
        const e = this.text[this.i + 1]
        this.i += 2
        switch (e) {
          case 'n': out += '\n'; break
          case 't': out += '\t'; break
          case 'r': out += '\r'; break
          case 'b': out += '\b'; break
          case 'f': out += '\u000c'; break
          case '0': out += '\u0000'; break
          case 'u': {
            const hex = this.text.slice(this.i, Math.min(this.i + 4, this.text.length))
            requireThat(hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex), 'Bad \\u escape')
            out += String.fromCharCode(parseInt(hex, 16))
            this.i += 4
            break
          }
          case '\\': case "'": case '"': out += e; break
          default: out += '\\' + e
        }
      } else {
        out += c
        this.i++
      }
    }
  }
}
