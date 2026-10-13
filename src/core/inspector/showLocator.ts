// ported-from: core/inspector/ShowLocator.kt
import { LocatorExtraction } from './locatorExtraction'
import { LocatorQuery } from './locatorQuery'
import type { UiNode } from './uiNode'

/** The result of trying a locator from the editor against a hierarchy. */
export abstract class ShowLocatorResult {
  /** One line for the balloon and the status line. */
  abstract message(): string

  /** True when something worth highlighting was found. */
  get isSuccess(): boolean {
    return this instanceof ShowLocatorResult.Matches && this.nodes.length > 0
  }
}

export namespace ShowLocatorResult {
  export class Matches extends ShowLocatorResult {
    constructor(
      readonly expression: string,
      readonly nodes: UiNode[],
    ) {
      super()
    }
    message(): string {
      switch (this.nodes.length) {
        case 0:
          return `no match: ${this.expression}`
        case 1:
          return `1 match (unique): ${this.expression}`
        default:
          return `${this.nodes.length} matches: ${this.expression}`
      }
    }
  }

  export class NotSupported extends ShowLocatorResult {
    constructor(
      readonly expression: string,
      readonly reason: string,
    ) {
      super()
    }
    message(): string {
      return `not supported: ${this.reason}`
    }
  }

  export class Failed extends ShowLocatorResult {
    constructor(readonly reason: string) {
      super()
    }
    message(): string {
      return `could not read the screen: ${this.reason}`
    }
  }

  class NoLocatorResult extends ShowLocatorResult {
    message(): string {
      return 'no locator found in the selection or on this line'
    }
  }

  class NoDeviceResult extends ShowLocatorResult {
    message(): string {
      return 'no device connected: connect one in Mobile Devices'
    }
  }

  export const NoLocator: ShowLocatorResult = new NoLocatorResult()
  export const NoDevice: ShowLocatorResult = new NoDeviceResult()
}

const removePrefix = (s: string, prefix: string): string => (s.startsWith(prefix) ? s.slice(prefix.length) : s)

export const ShowLocator = {
  /** Picks the locator out of [text] (a selection or a line of code) and evaluates it against [root]. Never throws. */
  evaluate(text: string, root: UiNode): ShowLocatorResult {
    const extracted = LocatorExtraction.extract(text)
    if (!extracted) return ShowLocatorResult.NoLocator
    return ShowLocator.evaluateExpression(extracted.expression, root)
  },

  evaluateExpression(expression: string, root: UiNode): ShowLocatorResult {
    try {
      return new ShowLocatorResult.Matches(expression, LocatorQuery.find(expression, root))
    } catch (e) {
      const raw = e instanceof Error ? e.message || e.name : String(e)
      const reason = removePrefix(removePrefix(raw.split(/\r\n|\n|\r/)[0], 'not supported yet: '), 'not supported: ')
      return new ShowLocatorResult.NotSupported(expression, reason)
    }
  },
}
