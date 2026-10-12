// ported-from: test:ui/ReplayUiSmokeTest.kt
// The recorder wiring that the Kotlin DeviceViewerPanel and RecorderPanel hold (record, assert, replay, list edits), with fakes for
// the viewer and the device. Also covers the gesture hook (the Kotlin ScreenInputHandler -> record / recordPoint).
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import type { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, type DeviceKey, type Size } from '../../src/core/model'
import { CountIs, WaitUntil, WaitState, Checks } from '../../src/core/recording/assertion'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { BaseDeviceSession, type FrameListener } from '../../src/core/session/deviceSession'
import { changesScreen, recordGesture, type Gesture, type GestureListener } from '../../src/extension/gestures'
import { RecorderController, type RecorderDeps, type RecorderView } from '../../src/extension/recorderController'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

class FakeSession extends BaseDeviceSession {
  readonly actions: string[] = []
  readonly device = makeDevice({ id: 'sim', name: 'Sim', platform: 'IOS', kind: 'SIMULATOR' })
  readonly transport = 'fake'
  readonly supportsInput = true
  start(_l: FrameListener): void {}
  logicalSize(): Size {
    return { width: 400, height: 800 }
  }
  async tap(x: number, y: number): Promise<void> {
    this.actions.push(`tap ${x},${y}`)
  }
  async swipe(): Promise<void> {
    this.actions.push('swipe')
  }
  async press(key: DeviceKey): Promise<void> {
    this.actions.push(`press ${key}`)
  }
  async typeText(text: string): Promise<void> {
    this.actions.push(`type ${text}`)
  }
  override async pressKeys(): Promise<void> {}
  async hierarchy(): Promise<UiNode> {
    return ios
  }
  close(): void {}
}

function setup(over: Partial<RecorderDeps> = {}) {
  const session = new FakeSession()
  const listeners = new Set<GestureListener>()
  const views: RecorderView[] = []
  const blocked: Array<string | undefined> = []
  let snapshots = false
  const settings = { recorderOutput: 'MOBILEWRIGHT', replayTimeoutSeconds: 1, replayDelayMs: 0 }
  const deps: RecorderDeps = {
    viewer: {
      onGesture: (l) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      startSnapshots: () => void (snapshots = true),
      stopSnapshots: () => void (snapshots = false),
      awaitSnapshot: async () => ({ root: ios, fresh: true }),
      blockInput: (r) => void blocked.push(r),
    },
    session: () => session,
    settings: () => settings,
    saveOutput: (n) => void (settings.recorderOutput = n),
    emit: (v) => void views.push(v),
    choose: async (_t, options) => options[0],
    askCount: async (n) => n,
    askTimeout: async () => 5,
    askScroll: async () => ({ direction: 'down', maxSwipes: 3 }),
    notify: () => {},
    ...over,
  }
  const c = new RecorderController(deps)
  const send = async (g: Gesture) => {
    for (const l of [...listeners]) await l(g)
  }
  return { c, session, views, blocked, send, settings, listeners, snapshots: () => snapshots }
}

describe('Recorder wiring', () => {
  it('records gestures reported by the viewer, in order, only while recording', async () => {
    const t = setup()
    await t.send({ kind: 'tap', x: 100, y: 220 })
    expect(t.c.view().rows).toHaveLength(0)
    t.c.setRecording(true)
    expect(t.snapshots()).toBe(true)
    await t.send({ kind: 'tap', x: 100, y: 220 })
    await t.send({ kind: 'text', text: 'hi' })
    await t.send({ kind: 'tap', x: 100, y: 320 })
    await t.send({ kind: 'key', key: 'HOME' })
    expect(t.c.view().rows.map((r) => r.text)).toEqual([
      "await screen.getByTestId('email-input').fill('hi');",
      "await screen.getByRole('button', { name: 'Sign In' }).tap();",
      "await screen.pressButton('HOME');",
    ])
    t.c.setRecording(false)
    expect(t.snapshots()).toBe(false)
    expect(t.listeners.size).toBe(0)
    expect(t.c.view().canReplay).toBe(true)
  })

  it('a tap without a hierarchy becomes a note', async () => {
    const rec = new ScriptRecorder('IOS')
    await recordGesture(rec, { kind: 'tap', x: 1, y: 2 }, async () => {
      throw new Error('no dump\nsecond line')
    })
    expect(rec.code()).toContain('hierarchy unavailable (no dump | second line)')
  })

  it('typing and Backspace do not change the screen, other gestures do', () => {
    expect(changesScreen({ kind: 'text', text: 'a' })).toBe(false)
    expect(changesScreen({ kind: 'key', key: 'DELETE' })).toBe(false)
    expect(changesScreen({ kind: 'key', key: 'ENTER' })).toBe(true)
    expect(changesScreen({ kind: 'tap', x: 0, y: 0 })).toBe(true)
  })

  it('does not start without a session or with input unavailable', () => {
    const t = setup({ session: () => undefined })
    t.c.setRecording(true)
    expect(t.c.isRecording).toBe(false)
    expect(t.c.view().message).toBe('Connect to a device first')
  })

  it('Assert picks an element, offers the checks and records the chosen one; a count is asked', async () => {
    let offered: string[] = []
    const t = setup({
      choose: async (_title, options) => {
        offered = options.map((o) => o.label)
        return options.find((o) => o instanceof WaitUntil) ?? options[0]
      },
    })
    t.c.setRecording(true)
    t.c.setArmed(true)
    expect(t.c.isArmed).toBe(true)
    await t.c.pick(100, 220)
    expect(t.c.isArmed).toBe(false)
    expect(offered.length).toBeGreaterThan(4)
    expect(t.c.view().rows).toHaveLength(1)
    expect(t.c.view().rows[0].text).toContain("waitFor({ state: 'visible' })")
    expect(t.c.view().rows[0].supportsTimeout).toBe(true)

    const picked = new ScriptRecorder('IOS').pick(ios, 100, 220)!
    const count = Checks.optionsFor(picked.node, 3).find((c) => c instanceof CountIs)
    expect(count?.label).toBe('Count of matching elements = 3')
  })

  it('Assert on nothing says so and records nothing', async () => {
    const t = setup()
    t.c.setRecording(true)
    t.c.setArmed(true)
    await t.c.pick(5000, 5000)
    expect(t.c.view().rows).toHaveLength(0)
    expect(t.c.view().message).toBe('No element with a locator there; click another one')
  })

  it('timeout and scroll edits follow the Kotlin rules', async () => {
    const t = setup({ choose: async (_t, o) => o.find((c) => c instanceof WaitUntil && c.state === WaitState.VISIBLE) })
    t.c.setRecording(true)
    await t.send({ kind: 'swipe', fromX: 200, fromY: 600, toX: 200, toY: 200 })
    t.c.setArmed(true)
    await t.c.pick(100, 220)
    t.c.setRecording(false)
    const rows = t.c.view().rows
    expect(rows[0].isSwipe).toBe(true)
    t.c.setTimeout([0], 5000)
    expect(t.c.view().message).toBe('Only wait and expect steps have a timeout')
    await t.c.askTimeout([1])
    expect(t.c.view().rows[1].text).toContain('timeout: 5000')
    expect(t.c.view().message).toBe('Timeout set to 5 s')
    t.c.setTimeout([1], undefined)
    expect(t.c.view().message).toBe('Timeout removed: the replay timeout setting applies')
    t.c.scrollUntilVisible([0])
    expect(t.c.view().rows[0].isScroll).toBe(true)
    await t.c.askScroll([0])
    expect(t.c.view().message).toBe('Scroll set to down, at most 3 swipes')
  })

  it('the Output setting changes display and Copy, not the recording', async () => {
    const t = setup()
    t.c.setRecording(true)
    await t.send({ kind: 'tap', x: 100, y: 220 })
    t.c.setOutput('APPIUM_PYTHON')
    expect(t.settings.recorderOutput).toBe('APPIUM_PYTHON')
    expect(t.c.code()).toContain('driver')
    expect(t.c.code()).not.toContain('screen.')
    expect(t.c.view().outputs.map((o) => o.value)).toContain('APPIUM_WEBDRIVERIO')
  })

  it('replays all steps or a range, marks each, blocks input meanwhile and reports the end', async () => {
    const t = setup()
    t.c.setRecording(true)
    await t.send({ kind: 'tap', x: 100, y: 220 })
    await t.send({ kind: 'tap', x: 100, y: 320 })
    await t.send({ kind: 'key', key: 'HOME' })
    t.c.setRecording(false)
    await t.c.replay({ first: 1, last: 2 })
    expect(t.session.actions).toEqual(['tap 195,322', 'press HOME'])
    const v = t.c.view()
    expect(v.rows.map((r) => r.state)).toEqual([undefined, 'PASSED', 'PASSED'])
    expect(v.message).toBe('Replay finished: all steps passed')
    expect(t.blocked).toEqual(['A replay is running: press Stop first', undefined])
    expect(t.c.isReplaying).toBe(false)
  })

  it('refuses to replay a recording of another platform, and while recording', async () => {
    const warnings: string[] = []
    const t = setup({ notify: (m) => void warnings.push(m) })
    t.c.setRecording(true)
    await t.send({ kind: 'tap', x: 100, y: 220 })
    await t.c.replay()
    expect(t.session.actions).toEqual([])
    t.c.setRecording(false)
    ;(t.c as unknown as { recorder: ScriptRecorder }).recorder = new ScriptRecorder('ANDROID')
    ;(t.c as unknown as { recorder: ScriptRecorder }).recorder.swipe(1, 2, 3, 4)
    await t.c.replay()
    expect(warnings).toEqual(['This recording is for ANDROID; connect a ANDROID device to replay it'])
  })

  it('a failing step stops the replay and is reported', async () => {
    const t = setup()
    t.c.setRecording(true)
    await t.send({ kind: 'tap', x: 100, y: 220 })
    t.c.setRecording(false)
    t.session.hierarchy = async () => WdaSourceParser.parse('<AppiumAUT><XCUIElementTypeApplication/></AppiumAUT>')
    await t.c.replay()
    expect(t.c.view().rows[0].state).toBe('FAILED')
    expect(t.c.view().message.startsWith('Step 1 failed:')).toBe(true)
  })

  it('clear empties the list', async () => {
    const t = setup()
    t.c.setRecording(true)
    await t.send({ kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4 })
    t.c.clear()
    expect(t.c.view().rows).toHaveLength(0)
  })
})
