// No Kotlin counterpart: java.lang.IllegalArgumentException and Kotlin's require(), used by the locator parsers
// so callers can tell "bad input, readable message" from an unexpected failure.

export class IllegalArgumentException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalArgumentException'
  }
}

/** Kotlin `require(condition) { message }`. */
export function requireThat(condition: boolean, message: string | (() => string)): asserts condition {
  if (!condition) throw new IllegalArgumentException(typeof message === 'function' ? message() : message)
}
