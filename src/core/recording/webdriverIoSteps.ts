// ported-from: core/recording/WebdriverIoSteps.kt
import type { Platform } from '../model'
import { WebdriverIo } from '../pageobject/locatorCode'
import type { PageLocator } from '../pageobject/pageObject'
import { Assertion, WaitState } from './assertion'
import { AppiumSteps, doubleToString } from './appiumSteps'
import { ScriptRecorder } from './scriptRecorder'

type Step = ScriptRecorder.Step
type Target = ScriptRecorder.Target

const DEFAULT_WAIT_MS = 10_000
const SWIPE_PERCENT = '0.75'
const IMPORT = "import { $, driver, expect } from '@wdio/globals';"

const str = (text: string): string => WebdriverIo.quote(text)

const el = (l: PageLocator.Appium): string => WebdriverIo.element(l)

const execute = (name: string, ...argumentList: [string, string][]): string => `await driver.execute(${str(`mobile: ${name}`)}, { ` + argumentList.map(([k, v]) => `${k}: ${v}`).join(', ') + ' });'

const swipe = (direction: string, android: boolean): string =>
  android
    ? execute(
        'swipeGesture',
        ['left', '0'],
        ['top', '0'],
        ['width', '(await driver.getWindowSize()).width'],
        ['height', '(await driver.getWindowSize()).height'],
        ['direction', str(direction)],
        ['percent', SWIPE_PERCENT],
      )
    : execute('swipe', ['direction', str(direction)])

/** `, { wait: 5000 }` for a step with its own timeout, nothing otherwise. */
const waitOption = (timeoutMs: number | undefined): string => (timeoutMs !== undefined ? `, { wait: ${timeoutMs} }` : '')

function assertion(l: PageLocator.Appium, a: Assertion, timeoutMs: number | undefined, android: boolean): string {
  const w = waitOption(timeoutMs)
  const opts = timeoutMs !== undefined ? `{ wait: ${timeoutMs} }` : ''
  let matcher: string
  if (a === Assertion.Visible) matcher = `toBeDisplayed(${opts})`
  else if (a === Assertion.Hidden) matcher = `not.toBeDisplayed(${opts})`
  else if (a instanceof Assertion.HasText) matcher = `toHaveText(${str(a.text)}${w})`
  else if (a instanceof Assertion.ContainsText) matcher = `toHaveText(expect.stringContaining(${str(a.text)})${w})`
  // Android keeps the content of an input in its text, iOS in its value.
  else if (a instanceof Assertion.HasValue) matcher = android ? `toHaveText(${str(a.value)}${w})` : `toHaveAttribute('value', ${str(a.value)}${w})`
  else if (a instanceof Assertion.Enabled) matcher = `${a.enabled ? '' : 'not.'}toBeEnabled(${opts})`
  else matcher = android ? `toHaveAttribute('checked', 'true'${w})` : `toHaveAttribute('value', '1'${w})`
  return `await expect(${el(l)}).${matcher};`
}

function waitFor(l: PageLocator.Appium, state: WaitState, timeoutMs: number | undefined): string {
  const timeout = `timeout: ${timeoutMs ?? DEFAULT_WAIT_MS}`
  let method: string
  let reverse: boolean
  switch (state) {
    case WaitState.VISIBLE:
      ;[method, reverse] = ['waitForDisplayed', false]
      break
    case WaitState.HIDDEN:
      ;[method, reverse] = ['waitForDisplayed', true]
      break
    case WaitState.ENABLED:
      ;[method, reverse] = ['waitForEnabled', false]
      break
    default:
      ;[method, reverse] = ['waitForEnabled', true]
  }
  return `await ${el(l)}.${method}({ ${reverse ? 'reverse: true, ' : ''}${timeout} });`
}

const elementId = (l: PageLocator.Appium): string => `(await ${el(l)}).elementId`

const noLocator = (what: string, target: Target): string[] => [`// ${what} ${target.code()}: no unique Appium locator for this element, give it an id or accessibility id`]

const withNote = (lines: string[], unverified: boolean): string[] =>
  unverified && lines.length > 0 ? [...lines.slice(0, -1), lines[lines.length - 1] + '  // check: matched against the screen before the previous action'] : lines

function onElement(what: string, target: Target, unverified: boolean, make: (l: PageLocator.Appium) => string[]): string[] {
  const l = target.appium
  if (l === undefined) return noLocator(what, target)
  return withNote(make(l), unverified)
}

/**
 * Renders recorded steps as Appium JavaScript with WebdriverIO. Pure text generation.
 *
 * Conventions: the code assumes `$`, `driver` and `expect` from `@wdio/globals` (a leading comment names the import). Elements are
 * found with the best unique Appium locator recorded with the step ([Target.appium]); a step whose element has none is written as
 * a comment. Assertions are the `expect-webdriverio` matchers, which retry; an explicit timeout becomes `{ wait }`. Explicit waits use
 * `waitForDisplayed` / `waitForEnabled` with `{ timeout }`. Gestures use the same `mobile:` commands as [AppiumSteps].
 */
export const WebdriverIoSteps = {
  render(steps: readonly Step[], platform: Platform): string {
    const body = steps.flatMap((it) => WebdriverIoSteps.lines(it, platform))
    const hasCode = body.some((it) => !it.trimStart().startsWith('//'))
    return [...(hasCode ? [`// ${IMPORT}`] : []), ...body].join('\n')
  },

  /** The lines of one step. */
  lines(step: Step, platform: Platform): string[] {
    const android = platform === 'ANDROID'
    if (step instanceof ScriptRecorder.Tap) return onElement('tap', step.target, step.unverified, (it) => [`await ${el(it)}.click();`])
    if (step instanceof ScriptRecorder.LongPress) {
      return onElement('long press', step.target, step.unverified, (it) => [
        android
          ? execute('longClickGesture', ['elementId', elementId(it)], ['duration', String(step.durationMs)])
          : execute('touchAndHold', ['elementId', elementId(it)], ['duration', doubleToString(step.durationMs / 1000.0)]),
      ])
    }
    if (step instanceof ScriptRecorder.DoubleTap) {
      return onElement('double tap', step.target, step.unverified, (it) => [execute(android ? 'doubleClickGesture' : 'doubleTap', ['elementId', elementId(it)])])
    }
    // setValue clears the field first, like the Mobilewright fill.
    if (step instanceof ScriptRecorder.Fill) return onElement('fill', step.target, step.unverified, (it) => [`await ${el(it)}.setValue(${str(step.text)});`])
    if (step instanceof ScriptRecorder.Expect) return onElement('expect', step.target, false, (it) => [assertion(it, step.assertion, step.timeoutMs, android)])
    if (step instanceof ScriptRecorder.ExpectCount) {
      return [`// expect count ${step.count} of ${step.target.withoutNth().code()}: no Appium form, the unique Appium locator of the element matches one element`]
    }
    if (step instanceof ScriptRecorder.WaitFor) return onElement('wait', step.target, false, (it) => [waitFor(it, step.state, step.timeoutMs)])
    if (step instanceof ScriptRecorder.Swipe) return [swipe(step.direction, android)]
    if (step instanceof ScriptRecorder.ScrollUntilVisible) {
      return onElement('scroll until visible', step.target, false, (it) => [
        `for (let i = 0; i < ${step.maxSwipes} && !(await ${el(it)}.isDisplayed()); i++) {`,
        `    ${swipe(step.direction, android)}`,
        '}',
      ])
    }
    if (step instanceof ScriptRecorder.Button) {
      if (step.name === 'HOME') return [android ? execute('pressKey', ['keycode', '3']) : execute('pressButton', ['name', str('home')])]
      return [`// press button ${step.name}: no Appium form`]
    }
    if (step === ScriptRecorder.GoBack) return ['await driver.back();']
    if (step instanceof ScriptRecorder.UnfocusedText) return [`// typed ${str(step.text)}: tap the field first so it can be recorded as fill`]
    return [`// ${AppiumSteps.appiumNote((step as ScriptRecorder.Note).text)}`]
  },
}
