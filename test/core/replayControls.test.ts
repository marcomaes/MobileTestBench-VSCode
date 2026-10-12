// ported-from: test:core/ReplayControlsTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { MobilewrightLocators, type Derived } from '../../src/core/inspector/locators'
import { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, type DeviceKey, type Size } from '../../src/core/model'
import { AppiumStrategy, PageLocator, PageObjectLanguage } from '../../src/core/pageobject/pageObject'
import { AppiumSteps } from '../../src/core/recording/appiumSteps'
import { Assertion, WaitState } from '../../src/core/recording/assertion'
import { intRange, ReplayOptions } from '../../src/core/recording/replayOptions'
import { ScriptPlayer, type ScriptPlayerState } from '../../src/core/recording/scriptPlayer'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { BaseDeviceSession, type FrameListener } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'

const Kind = MobilewrightLocators.Kind
const derived = (kind: Derived['kind'], value: string): Derived => ({ kind, value })
const Target = ScriptRecorder.Target
const S = ScriptRecorder

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))
const empty = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)

class Fake extends BaseDeviceSession {
  readonly actions: string[] = []
  readonly device = makeDevice({ id: 'sim', name: 'Sim', platform: 'IOS', kind: 'SIMULATOR' })
  readonly transport = 'fake'
  readonly supportsInput = true
  constructor(private readonly screen: () => UiNode) {
    super()
  }
  start(_listener: FrameListener): void {}
  logicalSize(): Size {
    return { width: 400, height: 800 }
  }
  async tap(x: number, y: number): Promise<void> {
    this.actions.push(`tap ${x},${y}`)
  }
  async swipe(_fromX: number, _fromY: number, _toX: number, _toY: number): Promise<void> {
    this.actions.push('swipe')
  }
  async press(key: DeviceKey): Promise<void> {
    this.actions.push(`press ${key}`)
  }
  async typeText(text: string): Promise<void> {
    this.actions.push(`type ${text}`)
  }
  override async pressKeys(_keys: string[]): Promise<void> {
    this.actions.push('keys')
  }
  async hierarchy(): Promise<UiNode> {
    return this.screen()
  }
  close(): void {}
}

const steps = (block: (r: ScriptRecorder) => void): ScriptRecorder.Step[] => {
  const r = new ScriptRecorder('IOS')
  block(r)
  return [...r.steps]
}

describe('ReplayControlsTest', () => {
  // ---- ReplayOptions

  it('settings are clamped and timeouts resolved', () => {
    expect(ReplayOptions.timeoutMs(0)).toBe(1000)
    expect(ReplayOptions.timeoutMs(999)).toBe(300_000)
    expect(ReplayOptions.timeoutMs(10)).toBe(10_000)
    expect(ReplayOptions.delayMs(-5)).toBe(0)
    expect(ReplayOptions.delayMs(50_000)).toBe(10_000)
    expect(ReplayOptions.resolveTimeoutMs(30_000, 10_000)).toBe(30_000)
    expect(ReplayOptions.resolveTimeoutMs(undefined, 10_000)).toBe(10_000)
    expect(ReplayOptions.resolveTimeoutMs(0, 10_000)).toBe(10_000)
    expect(ReplayOptions.parseStepSeconds(' 30 ')).toBe(30)
    expect(ReplayOptions.parseStepSeconds('0')).toBeUndefined()
    expect(ReplayOptions.parseStepSeconds('abc')).toBeUndefined()
    expect(ReplayOptions.parseStepSeconds('3601')).toBeUndefined()
    expect(ReplayOptions.wholeSeconds(1500)).toBe(2)
    expect(ReplayOptions.format(10_000)).toBe('10 s')
    expect(ReplayOptions.format(500)).toBe('0.5 s')
  })

  it('replay ranges from the selection', () => {
    expect(ReplayOptions.fromSelected([4, 2], 6)).toEqual(intRange(2, 5))
    expect(ReplayOptions.selectedRange([4, 2], 6)).toEqual(intRange(2, 4))
    expect(ReplayOptions.selectedRange([3], 6)).toEqual(intRange(3, 3))
    expect(ReplayOptions.fromSelected([], 6)).toBeUndefined()
    expect(ReplayOptions.selectedRange([9], 6)).toBeUndefined()
    expect(ReplayOptions.fromSelected([-1, 0], 6)).toEqual(intRange(0, 5))
  })

  it('only waits and expects take a timeout', () => {
    const t = new Target(derived(Kind.TEST_ID, 'x'))
    const wait = new S.WaitFor(t, WaitState.VISIBLE)
    expect(ReplayOptions.supportsTimeout(wait)).toBe(true)
    expect(ReplayOptions.supportsTimeout(new S.Expect(t, Assertion.Visible))).toBe(true)
    expect(ReplayOptions.supportsTimeout(new S.ExpectCount(t, 2))).toBe(true)
    expect(ReplayOptions.supportsTimeout(new S.Tap(t))).toBe(false)
    expect(ReplayOptions.supportsTimeout(new S.ScrollUntilVisible(t, 'up', 5))).toBe(false)
    expect(ReplayOptions.timeoutOf(ReplayOptions.withTimeout(wait, 5000))).toBe(5000)
    expect(ReplayOptions.timeoutOf(ReplayOptions.withTimeout(ReplayOptions.withTimeout(wait, 5000), undefined))).toBeUndefined()
    const tap = new S.Tap(t)
    expect(ReplayOptions.withTimeout(tap, 5000)).toEqual(tap)
  })

  it('recorder sets and removes a step timeout', () => {
    const r = new ScriptRecorder('IOS')
    const t = new Target(derived(Kind.TEST_ID, 'x'))
    r.add(t, Assertion.Visible)
    r.tap(ios, 100, 220)
    expect(r.setTimeout(0, 30_000)).toBe(true)
    expect(r.setTimeout(1, 30_000)).toBe(false)
    expect(r.setTimeout(7, 30_000)).toBe(false)
    expect(r.steps[0].code()).toBe("await expect(screen.getByTestId('x')).toBeVisible({ timeout: 30000 });")
    expect(r.setTimeout(0, undefined)).toBe(true)
    expect(r.steps[0].code()).toBe("await expect(screen.getByTestId('x')).toBeVisible();")
  })

  // ---- Mobilewright code

  it('mobilewright code carries the timeout option', () => {
    const t = new Target(derived(Kind.TEST_ID, 'x'))
    expect(new S.WaitFor(t, WaitState.VISIBLE, 30_000).code()).toBe("await screen.getByTestId('x').waitFor({ state: 'visible', timeout: 30000 });")
    expect(new S.WaitFor(t, WaitState.HIDDEN).code()).toBe("await screen.getByTestId('x').waitFor({ state: 'hidden' });")
    expect(new S.Expect(t, new Assertion.HasText('Hi'), 5000).code()).toBe("await expect(screen.getByTestId('x')).toHaveText('Hi', { timeout: 5000 });")
    expect(new S.ExpectCount(t, 3, 5000).code()).toBe("await expect(screen.getByTestId('x')).toHaveCount(3, { timeout: 5000 });")
    expect(new S.ExpectCount(t, 3).code()).toBe("await expect(screen.getByTestId('x')).toHaveCount(3);")
  })

  // ---- Appium code

  const byId = new Target(derived(Kind.TEST_ID, 'login'), undefined, undefined, new PageLocator.Appium(AppiumStrategy.ID, 'login'))
  const one = (step: ScriptRecorder.Step, l: PageObjectLanguage) => {
    const out = AppiumSteps.lines(step, l, 'ANDROID')
    expect(out.length).toBe(1)
    return out[0]
  }

  it('appium waits use a dedicated wait for a step with a timeout', () => {
    const w = new S.WaitFor(byId, WaitState.VISIBLE, 30_000)
    expect(one(w, PageObjectLanguage.APPIUM_JAVA)).toBe('new WebDriverWait(driver, Duration.ofSeconds(30)).until(ExpectedConditions.visibilityOfElementLocated(By.id("login")));')
    expect(one(w, PageObjectLanguage.APPIUM_KOTLIN)).toBe('WebDriverWait(driver, Duration.ofSeconds(30)).until(ExpectedConditions.visibilityOfElementLocated(By.id("login")))')
    expect(one(w, PageObjectLanguage.APPIUM_PYTHON)).toBe('WebDriverWait(driver, 30).until(EC.visibility_of_element_located((AppiumBy.ID, "login")))')
    expect(one(w, PageObjectLanguage.APPIUM_CSHARP)).toBe('new WebDriverWait(driver, TimeSpan.FromSeconds(30)).Until(d => d.FindElements(By.Id("login")).FirstOrDefault(e => e.Displayed));')
    const e = new S.WaitFor(byId, WaitState.ENABLED, 5000)
    expect(one(e, PageObjectLanguage.APPIUM_KOTLIN)).toBe('WebDriverWait(driver, Duration.ofSeconds(5)).until { it.findElement(By.id("login")).isEnabled }')
  })

  it('appium expect with a timeout and the default wait stay apart', () => {
    const ex = new S.Expect(byId, new Assertion.HasText('Hi'), 20_000)
    expect(one(ex, PageObjectLanguage.APPIUM_JAVA)).toBe(
      'assertEquals("Hi", new WebDriverWait(driver, Duration.ofSeconds(20)).until(ExpectedConditions.visibilityOfElementLocated(By.id("login"))).getText());',
    )
    const code = AppiumSteps.render([ex, new S.WaitFor(byId, WaitState.VISIBLE)], PageObjectLanguage.APPIUM_JAVA, 'ANDROID')
    const codeLines = code.split(/\r?\n/)
    expect(codeLines[codeLines.length - 1].startsWith('wait.until(')).toBe(true)
    expect(codeLines[0].includes('WebDriverWait wait = ')).toBe(true)
    // without any default wait the declaration is not needed
    const only = AppiumSteps.render([ex], PageObjectLanguage.APPIUM_JAVA, 'ANDROID')
    expect(only.includes('WebDriverWait wait = ')).toBe(false)
  })

  // ---- ScriptPlayer

  it('a step timeout overrides the default and a step without one uses it', async () => {
    const t = new Target(derived(Kind.TEST_ID, 'missing'))
    const own = [new S.WaitFor(t, WaitState.VISIBLE, 60)]
    const started = Date.now()
    let message: string | undefined
    const ok = await new ScriptPlayer(new Fake(() => ios), { elementTimeoutMs: 20_000, pollMs: 10 }).run(own, (_i, s, m) => {
      if (s === 'FAILED') message = m
    })
    expect(ok).toBe(false)
    expect(Date.now() - started < 5000).toBe(true)
    expect(message!.includes('0.1 s') || message!.includes('0.0 s')).toBe(true)
    // no own timeout: the default decides
    const dflt = [new S.Expect(t, Assertion.Visible)]
    const t0 = Date.now()
    expect(await new ScriptPlayer(new Fake(() => ios), { elementTimeoutMs: 150, pollMs: 10 }).run(dflt, () => {})).toBe(false)
    expect(Date.now() - t0 >= 140).toBe(true)
    // a longer own timeout beats a short default: the element appears after some polls
    let calls = 0
    const late = [new S.WaitFor(new Target(derived(Kind.TEST_ID, 'email-input')), WaitState.VISIBLE, 5000)]
    expect(await new ScriptPlayer(new Fake(() => (++calls < 6 ? empty : ios)), { elementTimeoutMs: 20, pollMs: 10 }).run(late, () => {})).toBe(true)
  })

  const tapSteps = () =>
    steps((r) => {
      r.tap(ios, 100, 220) // email
      r.tap(ios, 100, 320) // sign in
      r.swipe(200, 600, 200, 200)
      r.key('HOME')
    })

  it('replays only the range and reports absolute indices', async () => {
    const s = tapSteps()
    const session = new Fake(() => ios)
    const events: string[] = []
    const ok = await new ScriptPlayer(session, { pollMs: 10 }).run(s, (i, st) => events.push(`${i}:${st}`), undefined, intRange(1, 2))
    expect(ok).toBe(true)
    expect(session.actions).toEqual(['tap 195,322', 'swipe'])
    expect(events).toEqual(['1:RUNNING', '1:PASSED', '2:RUNNING', '2:PASSED'])
  })

  it('replay from a step stops at the first failure and ignores a range beyond the list', async () => {
    const s = tapSteps()
    const failing = new Fake(() => empty)
    const events: string[] = []
    expect(await new ScriptPlayer(failing, { elementTimeoutMs: 30, pollMs: 10 }).run(s, (i, st) => events.push(`${i}:${st}`), undefined, intRange(2, 9))).toBe(true)
    // step 2 is a swipe and does not need an element, step 3 is HOME: both pass; nothing out of range is reported
    expect(events).toEqual(['2:RUNNING', '2:PASSED', '3:RUNNING', '3:PASSED'])
    const failFrom1: string[] = []
    expect(await new ScriptPlayer(new Fake(() => empty), { elementTimeoutMs: 30, pollMs: 10 }).run(s, (i, st) => failFrom1.push(`${i}:${st}`), undefined, intRange(1, 3))).toBe(false)
    expect(failFrom1).toEqual(['1:RUNNING', '1:FAILED'])
    expect(await new ScriptPlayer(new Fake(() => ios), { pollMs: 10 }).run(s, () => {}, undefined, intRange(7, 9))).toBe(true)
  })

  it('the delay is waited between steps that run but not before the first', async () => {
    const pauses: number[] = []
    const session = new Fake(() => ios)
    const s = steps((r) => {
      r.tap(ios, 100, 220)
      r.type('x')
      r.tap(ios, 100, 320)
      r.key('HOME')
    }) // type("x") after a tap becomes fill: 3 steps
    const ok = await new ScriptPlayer(session, { pollMs: 10, stepDelayMs: 250, pause: (it) => void pauses.push(it) }).run(s, () => {})
    expect(ok).toBe(true)
    // 3 steps: 2 gaps of 250 ms each, in slices of at most 100 ms
    expect(pauses.reduce((a, b) => a + b, 0)).toBe(2 * 250)
    expect(pauses.every((it) => it <= 100)).toBe(true)
    const none: number[] = []
    await new ScriptPlayer(new Fake(() => ios), { pollMs: 10, stepDelayMs: 0, pause: (it) => void none.push(it) }).run(s, () => {})
    expect(none.length).toBe(0)
  })

  it('cancelling during the delay stops the run', async () => {
    const s = tapSteps()
    const session = new Fake(() => ios)
    let cancel = false
    const events: string[] = []
    const ok = await new ScriptPlayer(session, {
      pollMs: 10,
      stepDelayMs: 300,
      pause: () => {
        cancel = true
      },
    }).run(s, (i, st: ScriptPlayerState) => events.push(`${i}:${st}`), () => cancel)
    expect(ok).toBe(false)
    expect(session.actions).toEqual(['tap 195,222'])
    expect(events).toEqual(['0:RUNNING', '0:PASSED'])
  })
})
