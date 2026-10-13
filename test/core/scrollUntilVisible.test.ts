// ported-from: test:core/ScrollUntilVisibleTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, type DeviceKey, type Size } from '../../src/core/model'
import { Assertion, WaitState } from '../../src/core/recording/assertion'
import { ScriptPlayer } from '../../src/core/recording/scriptPlayer'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { ScrollUntilVisible as Conversion } from '../../src/core/recording/scrollUntilVisible'
import { BaseDeviceSession, type FrameListener } from '../../src/core/session/deviceSession'


const screen = (buttonY: number, visible = true): UiNode =>
  WdaSourceParser.parse(
    `<?xml version="1.0" encoding="UTF-8"?>
        <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="400" height="800">
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Sign In" label="Sign In" enabled="true" visible="${visible}" accessible="true" x="20" y="${buttonY}" width="350" height="44" index="1"/>
        </XCUIElementTypeApplication>`,
  )

const signIn = screen(300)

const recorder = (block: (r: ScriptRecorder) => void): ScriptRecorder => {
  const r = new ScriptRecorder('IOS')
  block(r)
  return r
}

const signInNode = (root: UiNode) => [...root.walk()].find((it) => it.attr('name') === 'Sign In')!

class FakeSession extends BaseDeviceSession {
  readonly actions: string[] = []
  readonly device = makeDevice({ id: 'sim', name: 'Sim', platform: 'IOS', kind: 'SIMULATOR' })
  readonly transport = 'fake'
  readonly supportsInput = true
  constructor(private readonly screens: (swipes: number) => UiNode) {
    super()
  }
  start(_listener: FrameListener): void {}
  logicalSize(): Size {
    return { width: 400, height: 800 }
  }
  async tap(x: number, y: number): Promise<void> {
    this.actions.push(`tap ${x},${y}`)
  }
  async swipe(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    this.actions.push(`swipe ${fromX},${fromY},${toX},${toY}`)
  }
  override async longPress(_x: number, _y: number): Promise<void> {}
  override async doubleTap(_x: number, _y: number): Promise<void> {}
  async press(_key: DeviceKey): Promise<void> {}
  async typeText(_text: string): Promise<void> {}
  override async pressKeys(_keys: string[]): Promise<void> {}
  async hierarchy(): Promise<UiNode> {
    return this.screens(this.actions.filter((it) => it.startsWith('swipe')).length)
  }
  close(): void {}
}

describe('ScrollUntilVisibleTest', () => {
  it('converts the swipes before an element step and writes a bounded loop', () => {
    const r = recorder((it) => {
      it.swipe(200, 600, 200, 200)
      it.swipe(200, 600, 200, 200)
      it.tap(signIn, 100, 320)
    })
    expect(r.scrollUntilVisible([0, 1])).toBeUndefined()
    expect(r.steps.length).toBe(2)
    const scroll = r.steps[0] as ScriptRecorder.ScrollUntilVisible
    expect(scroll.direction).toBe('up')
    expect(scroll.maxSwipes).toBe(10)
    expect(scroll.code()).toBe(
      "for (let i = 0; i < 10 && !(await screen.getByRole('button', { name: 'Sign In' }).isVisible()); i++) { await screen.swipe('up'); }",
    )
    expect(r.steps[1] instanceof ScriptRecorder.Tap).toBe(true)
  })

  it('rejects selections that cannot be converted and leaves the steps alone', () => {
    const r = recorder((it) => {
      it.swipe(200, 600, 200, 200)
      it.tap(signIn, 100, 320)
      it.swipe(200, 200, 200, 600)
      it.swipe(200, 200, 200, 600)
      it.swipe(0, 300, 300, 300)
    })
    const before = [...r.steps]
    expect(r.scrollUntilVisible([])).toBe('Select the swipe steps first')
    expect(r.scrollUntilVisible([0, 1])).toBe('Only swipe steps can be turned into a scroll')
    expect(r.scrollUntilVisible([0, 2])).toBe('The selected swipes must be next to each other')
    expect(r.scrollUntilVisible([3, 4])).toBe('The selected swipes go in different directions')
    expect(r.scrollUntilVisible([4])).toBe('There is no step after the swipes to scroll to')
    expect(r.scrollUntilVisible([9])).toBe('The selection is out of date')
    expect(r.steps).toEqual(before)
  })

  it('a step that is not about an element after the swipes is rejected', () => {
    const steps = [new ScriptRecorder.Swipe('up'), new ScriptRecorder.Swipe('up'), new ScriptRecorder.Button('HOME')]
    expect(Conversion.convert(steps, [0, 1]) instanceof Conversion.Result.Rejected).toBe(true)
  })

  it('many swipes raise the limit above the default', () => {
    const steps: ScriptRecorder.Step[] = [
      ...Array.from({ length: 12 }, () => new ScriptRecorder.Swipe('down')),
      new ScriptRecorder.Tap(ScriptRecorder.targetFor(signInNode(signIn), signIn)!),
    ]
    const result = Conversion.convert(steps, Array.from({ length: 12 }, (_, i) => i)) as InstanceType<typeof Conversion.Result.Converted>
    expect(result instanceof Conversion.Result.Converted).toBe(true)
    expect((result.steps[0] as ScriptRecorder.ScrollUntilVisible).maxSwipes).toBe(12)
  })

  it('on screen means visible with its center inside the screen', () => {
    const size = { width: 400, height: 800 }
    const button = (n: UiNode) => signInNode(n)
    expect(Conversion.isOnScreen(button(screen(300)), size)).toBe(true)
    expect(Conversion.isOnScreen(button(screen(900)), size)).toBe(false)
    expect(Conversion.isOnScreen(button(screen(300, false)), size)).toBe(false)
    expect(Conversion.isOnScreen(undefined, size)).toBe(false)
    expect(Conversion.isOnScreen(button(screen(790)), size)).toBe(false) // top edge on screen, center (812) below it
    expect(Conversion.isOnScreen(button(screen(770)), size)).toBe(true)
  })

  const converted = (maxSwipes = 10): ScriptRecorder.Step[] => {
    const r = recorder((it) => {
      it.swipe(200, 600, 200, 200)
      it.tap(signIn, 100, 320)
    })
    r.scrollUntilVisible([0])
    const scroll = r.steps[0] as ScriptRecorder.ScrollUntilVisible
    return [scroll.copy({ maxSwipes }), r.steps[1]]
  }

  it('replay swipes until the element is on screen and then taps it', async () => {
    const session = new FakeSession((swipes) => screen(1000 - swipes * 300)) // 1000, 700 (on screen after the first swipe)
    const ok = await new ScriptPlayer(session, { elementTimeoutMs: 200, pollMs: 5 }).run(converted(), () => {})
    expect(ok).toBe(true)
    expect(session.actions).toEqual(['swipe 200,560,200,240', 'tap 195,722'])
  })

  it('replay does not swipe when the element is already visible', async () => {
    const session = new FakeSession(() => screen(300))
    expect(await new ScriptPlayer(session, { elementTimeoutMs: 200, pollMs: 5 }).run(converted(), () => {})).toBe(true)
    expect(session.actions).toEqual(['tap 195,322'])
  })

  it('replay fails with a clear message after the maximum number of swipes', async () => {
    const session = new FakeSession(() => screen(5000))
    let message: string | undefined
    const ok = await new ScriptPlayer(session, { elementTimeoutMs: 50, pollMs: 5 }).run(converted(3), (_i, s, m) => {
      if (s === ScriptPlayer.State.FAILED) message = m
    })
    expect(ok).toBe(false)
    expect(session.actions.filter((it) => it.startsWith('swipe')).length).toBe(3)
    expect(message!.includes('did not become visible after 3 swipes up') && message!.includes('not on the screen'), message).toBe(true)
  })

  it('steps that expect the element to be hidden are not scroll targets', () => {
    const target = ScriptRecorder.targetFor(signInNode(signIn), signIn)!
    const swipe = new ScriptRecorder.Swipe('up')
    const rejected = (next: ScriptRecorder.Step) => Conversion.convert([swipe, next], [0]) instanceof Conversion.Result.Rejected
    expect(rejected(new ScriptRecorder.Expect(target, Assertion.Hidden))).toBe(true)
    expect(rejected(new ScriptRecorder.WaitFor(target, WaitState.HIDDEN))).toBe(true)
    expect(rejected(new ScriptRecorder.WaitFor(target, WaitState.VISIBLE))).toBe(false)
  })

  it('replay does not swipe while the hierarchy cannot be read', async () => {
    class Stuck extends FakeSession {
      readonly swipes: string[] = []
      override async swipe(): Promise<void> {
        this.swipes.push('swipe')
      }
      override async hierarchy(): Promise<UiNode> {
        throw new Error('agent stuck')
      }
    }
    const session = new Stuck(() => screen(5000))
    let message: string | undefined
    const ok = await new ScriptPlayer(session, { elementTimeoutMs: 50, pollMs: 5 }).run(converted(), (_i, s, m) => {
      if (s === ScriptPlayer.State.FAILED) message = m
    })
    expect(ok).toBe(false)
    expect(session.swipes.length).toBe(0)
    expect(message!.includes('did not become visible') && message!.includes('agent stuck'), message).toBe(true)
  })
})

describe('ScrollOptionsTest', () => {
  const signInRoot = WdaSourceParser.parse(
    `<?xml version="1.0" encoding="UTF-8"?>
        <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="400" height="800">
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Sign In" label="Sign In" enabled="true" visible="true" accessible="true" x="20" y="300" width="350" height="44" index="1"/>
        </XCUIElementTypeApplication>`,
  )

  const rec = () => {
    const r = new ScriptRecorder('IOS')
    r.swipe(200, 600, 200, 200)
    r.tap(signInRoot, 100, 320)
    r.scrollUntilVisible([0])
    return r
  }

  it('changes direction and limit and the code follows', () => {
    const r = rec()
    expect(r.setScrollOptions(0, 'down', 25)).toBe(true)
    const code = r.steps[0].code()
    expect(code.includes('i < 25') && code.includes("swipe('down')"), code).toBe(true)
  })

  it('rejects bad values and non scroll steps', () => {
    const r = rec()
    expect(r.setScrollOptions(0, 'sideways', 5)).toBe(false)
    expect(r.setScrollOptions(0, 'up', 0)).toBe(false)
    expect(r.setScrollOptions(0, 'up', 101)).toBe(false)
    expect(r.setScrollOptions(1, 'up', 5)).toBe(false)
    expect((r.steps[0] as ScriptRecorder.ScrollUntilVisible).maxSwipes).toBe(10)
  })

  it('parses limit', () => {
    expect(Conversion.parseLimit(' 7 ')).toBe(7)
    expect(Conversion.parseLimit('0')).toBeUndefined()
    expect(Conversion.parseLimit('x')).toBeUndefined()
  })
})
