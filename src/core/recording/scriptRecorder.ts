// ported-from: core/recording/ScriptRecorder.kt
import type { DeviceKey, Platform } from '../model'
import { rectArea } from '../model'
import { AccessibilityAudit } from '../inspector/accessibilityAudit'
import { MobilewrightLocators, type Derived } from '../inspector/locators'
import { ScopedLocators } from '../inspector/scopedLocators'
import { HierarchyQueries, type UiNode } from '../inspector/uiNode'
import { PageObjectCandidates, type PageLocator } from '../pageobject/pageObject'
import type { Assertion, Check, WaitState } from './assertion'
import { ReplayOptions } from './replayOptions'
import { ScrollUntilVisible as ScrollConversion } from './scrollUntilVisible'

/** How many levels above the tapped element are considered, e.g. a text inside a button. */
const MAX_CLIMB = 3

/** How much bigger than the tapped element a parent may be to still count as "the same control". */
const MAX_CLIMB_AREA_RATIO = 16
const UNVERIFIED_NOTE = '  // check: matched against the screen before the previous action'

const derivedEquals = (a: Derived | undefined, b: Derived | undefined): boolean => (a === undefined || b === undefined ? a === b : a.kind === b.kind && a.value === b.value && a.name === b.name)

const appiumEquals = (a: PageLocator.Appium | undefined, b: PageLocator.Appium | undefined): boolean => (a === undefined || b === undefined ? a === b : a.strategy === b.strategy && a.value === b.value)

/**
 * Turns what the user does on the device into Mobilewright code (`screen.getByTestId('x').tap()`).
 * Not thread safe: call it from one thread, e.g. the input executor.
 */
export class ScriptRecorder {
  constructor(readonly platform: Platform) {}

  private readonly recorded: ScriptRecorder.Step[] = []

  get steps(): readonly ScriptRecorder.Step[] {
    return this.recorded
  }

  get isEmpty(): boolean {
    return this.recorded.length === 0
  }

  code(): string {
    return this.recorded.map((it) => it.code()).join('\n')
  }

  clear(): void {
    this.recorded.length = 0
  }

  /**
   * Replaces the swipe steps at [indices] and the element step after them by one scroll-until-visible step plus
   * that element step. Returns undefined on success, or why it cannot be done.
   */
  scrollUntilVisible(indices: Iterable<number>): string | undefined {
    const result = ScrollConversion.convert(this.recorded, indices)
    if (result instanceof ScrollConversion.Result.Converted) {
      const steps = [...result.steps]
      this.recorded.length = 0
      this.recorded.push(...steps)
      return undefined
    }
    return (result as InstanceType<typeof ScrollConversion.Result.Rejected>).reason
  }

  /** Sets direction and swipe limit of the scroll step at [index]. Returns false when there is no such step or the values are not allowed. */
  setScrollOptions(index: number, direction: string, maxSwipes: number): boolean {
    const step = this.recorded[index]
    if (!(step instanceof ScriptRecorder.ScrollUntilVisible)) return false
    const changed = ScrollConversion.withOptions(step, direction, maxSwipes)
    if (changed === undefined) return false
    this.recorded[index] = changed
    return true
  }

  /** A tap at the logical point (x, y); [root] is the hierarchy as it was before the tap. */
  tap(root: UiNode, x: number, y: number, verified = true): void {
    this.recorded.push(this.pointStep(root, x, y, 'tap', (it) => new ScriptRecorder.Tap(it, !verified)))
  }

  /** A long press of [durationMs] at (x, y), tied to an element the same way a tap is. */
  longPress(root: UiNode, x: number, y: number, durationMs: number, verified = true): void {
    this.recorded.push(this.pointStep(root, x, y, 'long press', (it) => new ScriptRecorder.LongPress(it, durationMs, !verified)))
  }

  /**
   * A double tap. The mirror sends the first click as a tap before it knows it is a double click, so a tap on the
   * same element right before is the same gesture and is replaced.
   */
  doubleTap(root: UiNode, x: number, y: number, verified = true): void {
    const step = this.pointStep(root, x, y, 'double tap', (it) => new ScriptRecorder.DoubleTap(it, !verified))
    const last = this.recorded[this.recorded.length - 1]
    if (step instanceof ScriptRecorder.DoubleTap && last instanceof ScriptRecorder.Tap && last.target.equals(step.target)) this.replaceLast(step)
    else this.recorded.push(step)
  }

  /** Mobilewright has no drag API (only `screen.swipe` and `screen.gesture`), so a drag with hold is kept as a comment. */
  dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs: number): void {
    this.recorded.push(new ScriptRecorder.Note(`drag with hold (${holdMs} ms) from (${fromX}, ${fromY}) to (${toX}, ${toY}): Mobilewright has no drag API, not replayable`))
  }

  private pointStep(root: UiNode, x: number, y: number, what: string, make: (target: ScriptRecorder.Target) => ScriptRecorder.Step): ScriptRecorder.Step {
    const node = HierarchyQueries.deepestAt(root, x, y)
    const target = node !== undefined ? ScriptRecorder.targetFor(node, root) : undefined
    if (target !== undefined) return make(target)
    if (node !== undefined) return new ScriptRecorder.Note(`${what} at (${x}, ${y}) on ${node.type}: no locator, give the element a test id or label`)
    return new ScriptRecorder.Note(`${what} at (${x}, ${y}): no element found there`)
  }

  pick(root: UiNode, x: number, y: number): ScriptRecorder.Picked | undefined {
    const node = HierarchyQueries.deepestAt(root, x, y)
    if (node === undefined) return undefined
    const target = ScriptRecorder.targetFor(node, root)
    if (target === undefined) return undefined
    // The locator may resolve to a parent of the element under the finger (a button around its text).
    return new ScriptRecorder.Picked(target.resolve(root) ?? node, target, target.countMatches(root))
  }

  expect(target: ScriptRecorder.Target, assertion: Assertion): void {
    this.recorded.push(new ScriptRecorder.Expect(target, assertion))
  }

  /** Records whatever an Assert menu entry stands for: an assertion, a wait or a count. */
  add(target: ScriptRecorder.Target, check: Check): void {
    this.recorded.push(check.toStep(target))
  }

  /** Sets or removes (undefined) the own timeout of the wait or expect step at [index]. Returns false when there is no such step. */
  setTimeout(index: number, timeoutMs: number | undefined): boolean {
    const step = this.recorded[index]
    if (step === undefined || !ReplayOptions.supportsTimeout(step)) return false
    this.recorded[index] = ReplayOptions.withTimeout(step, timeoutMs)
    return true
  }

  /** Called when the hierarchy could not be read, so the tap cannot be tied to an element. */
  tapWithoutHierarchy(x: number, y: number, reason: string | undefined | null, what = 'tap'): void {
    this.recorded.push(new ScriptRecorder.Note(`${what} at (${x}, ${y}): hierarchy unavailable${reason !== undefined && reason !== null ? ` (${reason})` : ''}`))
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number): void {
    const dx = toX - fromX
    const dy = toY - fromY
    // The direction is the finger's: swipe up scrolls the content down.
    const direction = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right'
    this.recorded.push(new ScriptRecorder.Swipe(direction))
  }

  type(text: string): void {
    const last = this.recorded[this.recorded.length - 1]
    if (last instanceof ScriptRecorder.Tap) this.replaceLast(new ScriptRecorder.Fill(last.target, text, last.unverified))
    else if (last instanceof ScriptRecorder.Fill) this.replaceLast(new ScriptRecorder.Fill(last.target, last.text + text, last.unverified))
    else if (last instanceof ScriptRecorder.UnfocusedText) this.replaceLast(new ScriptRecorder.UnfocusedText(last.text + text))
    else this.recorded.push(new ScriptRecorder.UnfocusedText(text))
  }

  delete(): void {
    const last = this.recorded[this.recorded.length - 1]
    if (last instanceof ScriptRecorder.Fill) {
      this.replaceLast(last.text.length > 1 ? new ScriptRecorder.Fill(last.target, last.text.slice(0, -1), last.unverified) : new ScriptRecorder.Tap(last.target, last.unverified))
    } else if (last instanceof ScriptRecorder.UnfocusedText) {
      if (last.text.length > 1) this.replaceLast(new ScriptRecorder.UnfocusedText(last.text.slice(0, -1)))
      else this.recorded.pop()
    } else {
      this.recorded.push(new ScriptRecorder.Note('pressed Backspace'))
    }
  }

  key(key: DeviceKey): void {
    if (key === 'HOME') this.recorded.push(new ScriptRecorder.Button('HOME'))
    else if (key === 'BACK' && this.platform === 'ANDROID') this.recorded.push(ScriptRecorder.GoBack)
    else this.recorded.push(new ScriptRecorder.Note(`pressed ${key}`))
  }

  private replaceLast(step: ScriptRecorder.Step): void {
    this.recorded[this.recorded.length - 1] = step
  }
}

export namespace ScriptRecorder {
  /**
   * A locator. When it is not unique on the screen it is either scoped by a [parent] locator that is, or carries the
   * index among its matches ([nth]).
   */
  export class Target {
    constructor(
      readonly locator: Derived,
      readonly nth?: number,
      readonly parent?: Derived,
      /** The best unique Appium locator of the element, computed at record time; undefined when it has none. Used for the Appium output only. */
      readonly appium?: PageLocator.Appium,
    ) {}

    code(): string {
      return (this.parent !== undefined ? ScopedLocators.chain(this.parent, this.locator) : MobilewrightLocators.toCode(this.locator)) + (this.nth !== undefined ? `.nth(${this.nth})` : '')
    }

    /** The element this target points to in [root], counted the way the recorder counted ([nth] over all matches). */
    resolve(root: UiNode): UiNode | undefined {
      const all = [...root.walk()].filter((it) => !it.isRoot)
      let candidates: UiNode[]
      if (this.parent !== undefined) {
        const parent = this.parent
        const parents = all.filter((it) => MobilewrightLocators.matches(it, parent))
        if (parents.length !== 1) return undefined
        candidates = ScopedLocators.within(all, parents[0], this.locator)
      } else {
        const locator = this.locator
        candidates = all.filter((it) => MobilewrightLocators.matches(it, locator))
      }
      return candidates[this.nth ?? 0]
    }

    /** How many elements the locator matches in [root], ignoring [nth]: what Mobilewright's `count()` returns. */
    countMatches(root: UiNode): number {
      const all = [...root.walk()].filter((it) => !it.isRoot)
      if (this.parent === undefined) return all.filter((it) => MobilewrightLocators.matches(it, this.locator)).length
      const parent = this.parent
      const parents = all.filter((it) => MobilewrightLocators.matches(it, parent))
      if (parents.length !== 1) return 0
      return ScopedLocators.within(all, parents[0], this.locator).length
    }

    /** The same locator without the index, for assertions about all matches. */
    withoutNth(): Target {
      return this.copy({ nth: undefined })
    }

    /** Kotlin data class copy(). */
    copy(changes: { locator?: Derived; nth?: number | undefined; parent?: Derived | undefined; appium?: PageLocator.Appium | undefined }): Target {
      const has = (k: string) => Object.prototype.hasOwnProperty.call(changes, k)
      return new Target(
        has('locator') ? changes.locator! : this.locator,
        has('nth') ? changes.nth : this.nth,
        has('parent') ? changes.parent : this.parent,
        has('appium') ? changes.appium : this.appium,
      )
    }

    /** Kotlin data class equality. */
    equals(other: Target): boolean {
      return derivedEquals(this.locator, other.locator) && this.nth === other.nth && derivedEquals(this.parent, other.parent) && appiumEquals(this.appium, other.appium)
    }
  }

  export interface StepBase {
    code(): string
  }

  /** [unverified]: matched against a hierarchy from before the previous action, so the locator may be wrong. */
  export class Tap implements StepBase {
    constructor(
      readonly target: Target,
      readonly unverified = false,
    ) {}
    code(): string {
      return `await ${this.target.code()}.tap();` + (this.unverified ? UNVERIFIED_NOTE : '')
    }
  }

  /** `await loc.longPress({ duration: 700 });` */
  export class LongPress implements StepBase {
    constructor(
      readonly target: Target,
      readonly durationMs: number,
      readonly unverified = false,
    ) {}
    code(): string {
      return `await ${this.target.code()}.longPress({ duration: ${this.durationMs} });` + (this.unverified ? UNVERIFIED_NOTE : '')
    }
  }

  export class DoubleTap implements StepBase {
    constructor(
      readonly target: Target,
      readonly unverified = false,
    ) {}
    code(): string {
      return `await ${this.target.code()}.doubleTap();` + (this.unverified ? UNVERIFIED_NOTE : '')
    }
  }

  export class Fill implements StepBase {
    constructor(
      readonly target: Target,
      readonly text: string,
      readonly unverified = false,
    ) {}
    code(): string {
      return `await ${this.target.code()}.fill(${MobilewrightLocators.js(this.text)});` + (this.unverified ? UNVERIFIED_NOTE : '')
    }
  }

  /** `await expect(locator).toHaveText('x');`. Needs `expect` from `@mobilewright/test`. */
  export class Expect implements StepBase {
    constructor(
      readonly target: Target,
      readonly assertion: Assertion,
      readonly timeoutMs?: number,
    ) {}
    code(): string {
      return `await expect(${this.target.code()})${ReplayOptions.matcherWithTimeout(this.assertion.matcher(), this.timeoutMs)};`
    }
    copy(changes: { timeoutMs?: number | undefined }): Expect {
      return new Expect(this.target, this.assertion, 'timeoutMs' in changes ? changes.timeoutMs : this.timeoutMs)
    }
  }

  /** `await expect(locator).toHaveCount(3);`. The locator is written without `.nth()`: it counts all matches. */
  export class ExpectCount implements StepBase {
    constructor(
      readonly target: Target,
      readonly count: number,
      readonly timeoutMs?: number,
    ) {}
    code(): string {
      return `await expect(${this.target.withoutNth().code()})${ReplayOptions.matcherWithTimeout(`.toHaveCount(${this.count})`, this.timeoutMs)};`
    }
    copy(changes: { timeoutMs?: number | undefined }): ExpectCount {
      return new ExpectCount(this.target, this.count, 'timeoutMs' in changes ? changes.timeoutMs : this.timeoutMs)
    }
  }

  /** `await locator.waitFor({ state: 'visible' });`: an explicit wait, no assertion. */
  export class WaitFor implements StepBase {
    constructor(
      readonly target: Target,
      readonly state: WaitState,
      readonly timeoutMs?: number,
    ) {}
    code(): string {
      return `await ${this.target.code()}.waitFor({ state: '${this.state.js}'${this.timeoutMs !== undefined ? `, timeout: ${this.timeoutMs}` : ''} });`
    }
    copy(changes: { timeoutMs?: number | undefined }): WaitFor {
      return new WaitFor(this.target, this.state, 'timeoutMs' in changes ? changes.timeoutMs : this.timeoutMs)
    }
  }

  export class Swipe implements StepBase {
    constructor(readonly direction: string) {}
    code(): string {
      return `await screen.swipe('${this.direction}');`
    }
  }

  /**
   * Swipe in [direction] until [target] is visible on screen, at most [maxSwipes] times. Made from recorded swipes
   * by [ScrollConversion.convert]. `isVisible()` is the Mobilewright locator method; it was not run against Mobilewright.
   */
  export class ScrollUntilVisible implements StepBase {
    constructor(
      readonly target: Target,
      readonly direction: string,
      readonly maxSwipes: number,
    ) {}
    code(): string {
      return `for (let i = 0; i < ${this.maxSwipes} && !(await ${this.target.code()}.isVisible()); i++) { await screen.swipe('${this.direction}'); }`
    }
    copy(changes: { target?: Target; direction?: string; maxSwipes?: number }): ScrollUntilVisible {
      return new ScrollUntilVisible(changes.target ?? this.target, changes.direction ?? this.direction, changes.maxSwipes ?? this.maxSwipes)
    }
  }

  export class Button implements StepBase {
    constructor(readonly name: string) {}
    code(): string {
      return `await screen.pressButton('${this.name}');`
    }
  }

  class GoBackStep implements StepBase {
    code(): string {
      return 'await screen.goBack();'
    }
  }
  export const GoBack = new GoBackStep()
  export type GoBack = GoBackStep

  /** Typed text with no element tapped before it, so there is nothing to `fill`. */
  export class UnfocusedText implements StepBase {
    constructor(readonly text: string) {}
    code(): string {
      return `// typed ${MobilewrightLocators.js(this.text)}: tap the field first so it can be recorded as fill()`
    }
  }

  export class Note implements StepBase {
    constructor(readonly text: string) {}
    code(): string {
      return `// ${this.text}`
    }
  }

  export type Step = Tap | LongPress | DoubleTap | Fill | Expect | ExpectCount | WaitFor | Swipe | ScrollUntilVisible | Button | GoBackStep | UnfocusedText | Note

  /** The element under (x, y) and the locator the recorder would use for it. */
  export class Picked {
    constructor(
      readonly node: UiNode,
      readonly target: Target,
      readonly matchCount = 1,
    ) {}
  }

  /**
   * The most stable locator for what the user meant to tap. The tapped element and up to [MAX_CLIMB]
   * ancestors (stopping at the first control or cell) are candidates: a unique test id wins, then any
   * unique locator, then the same locator inside a parent that is unique, then the first locator with its index among duplicates.
   */
  export function targetFor(node: UiNode, root: UiNode): Target | undefined {
    const target = mobilewrightTarget(node, root)
    if (target === undefined) return undefined
    const element = target.resolve(root) ?? node
    return target.copy({ appium: PageObjectCandidates.appiumLocatorFor(element, root) })
  }

  function mobilewrightTarget(node: UiNode, root: UiNode): Target | undefined {
    const all = [...root.walk()].filter((it) => !it.isRoot)
    const nodeArea = node.bounds !== undefined ? rectArea(node.bounds) : 0
    const candidates: UiNode[] = []
    let current: UiNode | undefined = node
    while (current !== undefined && !current.isRoot && candidates.length <= MAX_CLIMB) {
      // A parent far bigger than the tapped element is a container (a list), not the thing that was tapped.
      if (current !== node && nodeArea > 0 && (current.bounds !== undefined ? rectArea(current.bounds) : Number.MAX_SAFE_INTEGER) > nodeArea * MAX_CLIMB_AREA_RATIO) break
      candidates.push(current)
      if (AccessibilityAudit.isInteractive(current) || current.type.toLowerCase() === 'cell') break
      current = current.parent
    }
    const unique = (n: UiNode, testIdOnly: boolean): Derived | undefined =>
      MobilewrightLocators.deriveAll(n).find((d) => (!testIdOnly || d.kind === MobilewrightLocators.Kind.TEST_ID) && all.filter((it) => MobilewrightLocators.matches(it, d)).length === 1)
    for (const n of candidates) {
      const d = unique(n, true)
      if (d !== undefined) return new Target(d)
    }
    for (const n of candidates) {
      const d = unique(n, false)
      if (d !== undefined) return new Target(d)
    }
    // Inside a parent: a test id (of the button around the tapped text, say) beats a text locator of the tapped text.
    const scopedCandidates = candidates.map((it) => ScopedLocators.forNode(it, root)).filter((it) => it !== undefined)
    const scoped = scopedCandidates.find((it) => it.child.kind === MobilewrightLocators.Kind.TEST_ID) ?? scopedCandidates[0]
    if (scoped !== undefined) return new Target(scoped.child, undefined, scoped.parent)
    const first = candidates.find((it) => MobilewrightLocators.derive(it) !== undefined)
    if (first === undefined) return undefined
    const derived = MobilewrightLocators.derive(first)!
    const matches = all.filter((it) => MobilewrightLocators.matches(it, derived))
    return new Target(derived, matches.indexOf(first))
  }
}
