// ported-from: core/recording/Assertion.kt
import type { Platform } from '../model'
import { MobilewrightLocators } from '../inspector/locators'
import type { UiNode } from '../inspector/uiNode'
import { ScriptRecorder } from './scriptRecorder'

/** One entry of the Assert menu: turns the clicked element's locator into a recorded step. */
export interface Check {
  /** Short description for a menu. */
  readonly label: string
  toStep(target: ScriptRecorder.Target): ScriptRecorder.Step
}

/**
 * Mobilewright's `locator.waitFor({ state })`, with the same rules as its `checkState`: `hidden` also holds for an
 * element that is not on the screen, `disabled` needs the element to exist.
 */
export interface WaitState {
  readonly name: string
  readonly js: string
  holds(node: UiNode | undefined): boolean
}

const waitState = (name: string, js: string, holds: (node: UiNode | undefined) => boolean): WaitState => ({ name, js, holds })

const VISIBLE = waitState('VISIBLE', 'visible', (node) => node !== undefined && node.isVisible)
const HIDDEN = waitState('HIDDEN', 'hidden', (node) => node === undefined || !node.isVisible)
const ENABLED = waitState('ENABLED', 'enabled', (node) => node !== undefined && Assertion.isEnabled(node))
const DISABLED = waitState('DISABLED', 'disabled', (node) => node !== undefined && !Assertion.isEnabled(node))

export const WaitState = { VISIBLE, HIDDEN, ENABLED, DISABLED, entries: [VISIBLE, HIDDEN, ENABLED, DISABLED] as readonly WaitState[] }

/** An explicit wait step: `await locator.waitFor({ state: 'visible' });`. */
export class WaitUntil implements Check {
  constructor(readonly state: WaitState) {}
  get label(): string {
    return `Wait until ${this.state.js}`
  }
  toStep(target: ScriptRecorder.Target): ScriptRecorder.Step {
    return new ScriptRecorder.WaitFor(target, this.state)
  }
}

/** `await expect(locator).toHaveCount(n);`: how many elements match a locator shared by repeated elements. */
export class CountIs implements Check {
  constructor(readonly count: number) {}
  get label(): string {
    return `Count of matching elements = ${this.count}`
  }
  toStep(target: ScriptRecorder.Target): ScriptRecorder.Step {
    return new ScriptRecorder.ExpectCount(target, this.count)
  }
}

export const Checks = {
  /**
   * The whole Assert menu for an element: the assertions that fit it, then "becomes hidden", the explicit waits and, when
   * the locator matches [matchCount] >= 2 elements, a count assertion prefilled with that number.
   */
  optionsFor(node: UiNode, matchCount = 1): Check[] {
    const out: Check[] = [...Assertion.optionsFor(node)]
    out.push(Assertion.Hidden)
    for (const state of WaitState.entries) out.push(new WaitUntil(state))
    if (matchCount >= 2) out.push(new CountIs(matchCount))
    return out
  },
}

/**
 * Something to check about an element, written as a Mobilewright `expect(locator)` matcher. Mobilewright
 * assertions retry until they hold, so recording one doubles as an explicit wait.
 */
export interface Assertion extends Check {
  /** The matcher after `expect(locator)`, e.g. `.toHaveText('Welcome')`. */
  matcher(): string
  holds(node: UiNode): boolean
  /** True when an element that is not on the screen at all satisfies this assertion (Mobilewright's `toBeHidden`). */
  readonly passesWhenMissing: boolean
  /** What the element has instead, for a failure message. */
  actual(node: UiNode): string
}

const MAX_LABEL_TEXT = 30

const quote = (text: string): string => "'" + (text.length > MAX_LABEL_TEXT ? text.slice(0, MAX_LABEL_TEXT) + '...' : text) + "'"

const inputTypes = new Set(['textfield', 'securetextfield', 'searchfield', 'edittext', 'reactedittext'])
const checkTypes = new Set(['switch', 'toggle', 'checkbox', 'checkedtextview', 'radiobutton', 'togglebutton'])

abstract class AssertionBase implements Assertion {
  abstract matcher(): string
  abstract holds(node: UiNode): boolean
  abstract actual(node: UiNode): string
  abstract get label(): string
  get passesWhenMissing(): boolean {
    return false
  }
  toStep(target: ScriptRecorder.Target): ScriptRecorder.Step {
    return new ScriptRecorder.Expect(target, this)
  }
}

export namespace Assertion {
  class VisibleAssertion extends AssertionBase {
    matcher = () => '.toBeVisible()'
    get label() {
      return 'Is visible'
    }
    holds = (node: UiNode) => node.isVisible
    actual = (node: UiNode) => (node.isVisible ? 'visible' : 'not visible')
  }
  export const Visible: Assertion = new VisibleAssertion()

  /** Mobilewright: `toBeHidden()` is `!isVisible`, so an element that left the screen counts as hidden. */
  class HiddenAssertion extends AssertionBase {
    matcher = () => '.toBeHidden()'
    get label() {
      return 'Becomes hidden'
    }
    holds = (node: UiNode) => !node.isVisible
    override get passesWhenMissing() {
      return true
    }
    actual = (_node: UiNode) => 'visible'
  }
  export const Hidden: Assertion = new HiddenAssertion()

  export class HasText extends AssertionBase {
    constructor(readonly text: string) {
      super()
    }
    matcher = () => `.toHaveText(${MobilewrightLocators.js(this.text)})`
    get label() {
      return `Has text ${quote(this.text)}`
    }
    holds = (node: UiNode) => visibleText(node) === this.text
    actual = (node: UiNode) => quote(visibleText(node) ?? '')
  }

  export class ContainsText extends AssertionBase {
    constructor(readonly text: string) {
      super()
    }
    matcher = () => `.toContainText(${MobilewrightLocators.js(this.text)})`
    get label() {
      return `Contains text ${quote(this.text)}`
    }
    holds = (node: UiNode) => visibleText(node)?.includes(this.text) === true
    actual = (node: UiNode) => quote(visibleText(node) ?? '')
  }

  export class HasValue extends AssertionBase {
    constructor(readonly value: string) {
      super()
    }
    matcher = () => `.toHaveValue(${MobilewrightLocators.js(this.value)})`
    get label() {
      return `Has value ${quote(this.value)}`
    }
    holds = (node: UiNode) => inputValue(node) === this.value
    actual = (node: UiNode) => quote(inputValue(node) ?? '')
  }

  export class Enabled extends AssertionBase {
    constructor(readonly enabled: boolean) {
      super()
    }
    matcher = () => (this.enabled ? '.toBeEnabled()' : '.toBeDisabled()')
    get label() {
      return this.enabled ? 'Is enabled' : 'Is disabled'
    }
    holds = (node: UiNode) => isEnabled(node) === this.enabled
    actual = (node: UiNode) => (isEnabled(node) ? 'enabled' : 'disabled')
  }

  class CheckedAssertion extends AssertionBase {
    matcher = () => '.toBeChecked()'
    get label() {
      return 'Is checked'
    }
    holds = (node: UiNode) => isChecked(node)
    actual = (node: UiNode) => (isChecked(node) ? 'checked' : 'not checked')
  }
  export const Checked: Assertion = new CheckedAssertion()

  /** What Mobilewright's `getText()` reads: the visible text or label. */
  export function visibleText(node: UiNode): string | undefined {
    const t = node.text ?? node.label ?? node.value
    return t !== undefined && t.length > 0 ? t : undefined
  }

  /** The content of an input: iOS `value`, Android `text`. */
  export function inputValue(node: UiNode): string | undefined {
    const platform: Platform = node.platform
    return platform === 'IOS' ? node.value : node.text
  }

  export function isEnabled(node: UiNode): boolean {
    return node.attr('enabled') !== 'false'
  }

  export function isChecked(node: UiNode): boolean {
    return node.platform === 'ANDROID' ? node.attr('checked') === 'true' : node.value === '1' || node.value?.toLowerCase() === 'true'
  }

  /** The assertions that make sense for this element as it is now, most useful first. */
  export function optionsFor(node: UiNode): Assertion[] {
    const out: Assertion[] = [Visible]
    const type = node.type.toLowerCase()
    const text = visibleText(node)
    if (inputTypes.has(type)) {
      const v = inputValue(node)
      if (v !== undefined && v.length > 0) out.push(new HasValue(v))
    } else if (text !== undefined) {
      out.push(new HasText(text))
      if (text.length > 12) out.push(new ContainsText(text.slice(0, 12).trim()))
    }
    out.push(new Enabled(isEnabled(node)))
    if (checkTypes.has(type) && isChecked(node)) out.push(Checked)
    return out
  }
}
