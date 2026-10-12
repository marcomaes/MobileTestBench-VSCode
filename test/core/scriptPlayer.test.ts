// ported-from: test:core/ScriptPlayerTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, type DeviceKey, type Size } from '../../src/core/model'
import { BaseDeviceSession, type FrameListener } from '../../src/core/session/deviceSession'
import { ScriptPlayer, type ScriptPlayerState } from '../../src/core/recording/scriptPlayer'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

class FakeSession extends BaseDeviceSession {
  readonly actions: string[] = []
  readonly device = makeDevice({ id: 'sim', name: 'Sim', platform: 'IOS', kind: 'SIMULATOR' })
  readonly transport = 'fake'
  readonly supportsInput = true
  constructor(
    private readonly screens: () => UiNode,
    private readonly size: Size | undefined = { width: 400, height: 800 },
  ) {
    super()
  }
  start(_listener: FrameListener): void {}
  logicalSize(): Size | undefined {
    return this.size
  }
  async tap(x: number, y: number): Promise<void> {
    this.actions.push(`tap ${x},${y}`)
  }
  async swipe(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    this.actions.push(`swipe ${fromX},${fromY},${toX},${toY}`)
  }
  override async longPress(x: number, y: number, durationMs = 700): Promise<void> {
    this.actions.push(`longpress ${x},${y},${durationMs}`)
  }
  override async doubleTap(x: number, y: number): Promise<void> {
    this.actions.push(`doubletap ${x},${y}`)
  }
  async press(key: DeviceKey): Promise<void> {
    this.actions.push(`press ${key}`)
  }
  async typeText(text: string): Promise<void> {
    this.actions.push(`type ${text}`)
  }
  override async pressKeys(keys: string[]): Promise<void> {
    this.actions.push(`keys ${keys.join(' ')}`)
  }
  async hierarchy(): Promise<UiNode> {
    return this.screens()
  }
  close(): void {}
}

const recorded = (block: (r: ScriptRecorder) => void): ScriptRecorder.Step[] => {
  const r = new ScriptRecorder('IOS')
  block(r)
  return [...r.steps]
}

describe('ScriptPlayerTest', () => {
  it('replays taps, fill, swipes and buttons and reports each step', async () => {
    const steps = recorded((r) => {
      r.tap(ios, 100, 220) // email field: 20,200 350x44
      r.type('hi')
      r.tap(ios, 100, 320) // Sign In button: 20,300 350x44
      r.swipe(200, 600, 200, 200)
      r.key('HOME')
    })
    const session = new FakeSession(() => ios)
    const events: string[] = []
    const ok = await new ScriptPlayer(session, { elementTimeoutMs: 200, pollMs: 10 }).run(steps, (i, state) => events.push(`${i}:${state}`))
    expect(ok).toBe(true)
    expect(session.actions).toEqual(['tap 195,222', 'keys cmd+a backspace', 'type hi', 'tap 195,322', 'swipe 200,560,200,240', 'press HOME'])
    expect(events.slice(0, 8)).toEqual(['0:RUNNING', '0:PASSED', '1:RUNNING', '1:PASSED', '2:RUNNING', '2:PASSED', '3:RUNNING', '3:PASSED'])
  })

  it('an element that never appears fails the step and stops the run', async () => {
    const steps = recorded((r) => {
      r.tap(ios, 100, 220)
      r.tap(ios, 100, 320)
    })
    const empty = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    const session = new FakeSession(() => empty)
    const events: [number, ScriptPlayerState, string | undefined][] = []
    const ok = await new ScriptPlayer(session, { elementTimeoutMs: 60, pollMs: 10 }).run(steps, (i, s, m) => events.push([i, s, m]))
    expect(ok).toBe(false)
    expect(session.actions.length).toBe(0)
    const failed = events.filter((it) => it[1] === 'FAILED')
    expect(failed.length).toBe(1)
    expect(failed[0][0]).toBe(0)
    expect(failed[0][2]!.includes('email-input') && failed[0][2]!.includes('not found')).toBe(true)
    expect(events.every((it) => it[0] !== 1)).toBe(true)
  })

  it('waits for an element that appears later', async () => {
    const steps = recorded((r) => r.tap(ios, 100, 220))
    const empty = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    let calls = 0
    const session = new FakeSession(() => (++calls < 4 ? empty : ios))
    expect(await new ScriptPlayer(session, { elementTimeoutMs: 2000, pollMs: 10 }).run(steps, () => {})).toBe(true)
    expect(session.actions).toEqual(['tap 195,222'])
  })

  it('comments are skipped and cancelling stops the run', async () => {
    const steps = recorded((r) => {
      r.type('x')
      r.tap(ios, 100, 220)
    })
    const session = new FakeSession(() => ios)
    const states: ScriptPlayerState[] = []
    await new ScriptPlayer(session, { elementTimeoutMs: 100, pollMs: 10 }).run(steps, (_i, s) => states.push(s), () => states.length >= 1)
    expect(states).toEqual(['SKIPPED'])
    expect(session.actions.length).toBe(0)
  })

  it('a failing hierarchy dump is reported in the failure', async () => {
    const steps = recorded((r) => r.tap(ios, 100, 220))
    const session = new FakeSession(() => {
      throw new Error('no XML content')
    })
    let message: string | undefined
    await new ScriptPlayer(session, { elementTimeoutMs: 50, pollMs: 10 }).run(steps, (_i, s, m) => {
      if (s === 'FAILED') message = m
    })
    expect(message!.includes('no XML content')).toBe(true)
  })

  it('replays a long press with its duration and a double tap on the element center', async () => {
    const steps = recorded((r) => {
      r.longPress(ios, 100, 220, 900)
      r.doubleTap(ios, 100, 320)
      r.dragWithHold(1, 2, 3, 4, 700)
    })
    const session = new FakeSession(() => ios)
    const states: ScriptPlayerState[] = []
    expect(await new ScriptPlayer(session, { elementTimeoutMs: 100, pollMs: 10 }).run(steps, (_i, s) => states.push(s))).toBe(true)
    expect(session.actions).toEqual(['longpress 195,222,900', 'doubletap 195,322'])
    expect(states[states.length - 1]).toBe('SKIPPED')
  })
})
