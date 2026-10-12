// ported-from: test:core/WaitsAndFillTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, type DeviceKey, type Platform, type Size } from '../../src/core/model'
import { Assertion, Checks, CountIs, WaitState, WaitUntil } from '../../src/core/recording/assertion'
import { ScriptPlayer } from '../../src/core/recording/scriptPlayer'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { TextClearing } from '../../src/core/recording/textClearing'
import { BaseDeviceSession, UnsupportedOperationOnDevice, type DeviceSession, type FrameListener } from '../../src/core/session/deviceSession'

const screen = (...children: string[]): UiNode =>
  WdaSourceParser.parse(
    `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Demo" label="Demo" enabled="true" visible="true" x="0" y="0" width="400" height="800">
             <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="400" height="800">
               ${children.join('\n')}
             </XCUIElementTypeWindow></XCUIElementTypeApplication>`,
  )

const button = (name: string, y: number, visible = true, enabled = true) =>
  `<XCUIElementTypeButton type="XCUIElementTypeButton" name="${name}" label="${name}" enabled="${enabled}" visible="${visible}" x="20" y="${y}" width="200" height="40"/>`

const field = (value: string | null) =>
  `<XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email-input" label="Email" ${value !== null ? `value="${value}"` : ''} enabled="true" visible="true" x="20" y="200" width="300" height="44"/>`

class FakeSession extends BaseDeviceSession {
  readonly actions: string[] = []
  readonly device
  readonly transport = 'fake'
  readonly supportsInput = true
  constructor(
    private readonly screens: () => UiNode,
    platform: Platform = 'IOS',
    private readonly onKeys: (keys: string[]) => void = () => {},
  ) {
    super()
    this.device = makeDevice({ id: 'd', name: 'D', platform, kind: 'SIMULATOR' })
  }
  start(_listener: FrameListener): void {}
  logicalSize(): Size {
    return { width: 400, height: 800 }
  }
  async tap(x: number, y: number): Promise<void> {
    this.actions.push(`tap ${x},${y}`)
  }
  async swipe(_fromX: number, _fromY: number, _toX: number, _toY: number): Promise<void> {}
  async press(_key: DeviceKey): Promise<void> {}
  async typeText(text: string): Promise<void> {
    this.actions.push(`type ${text}`)
  }
  override async pressKeys(keys: string[]): Promise<void> {
    this.actions.push(`keys ${keys.join(' ')}`)
    this.onKeys(keys)
  }
  async hierarchy(): Promise<UiNode> {
    return this.screens()
  }
  close(): void {}
}

const targetAt = (root: UiNode, y: number) => new ScriptRecorder('IOS').pick(root, 100, y)!.target

async function run(session: DeviceSession, step: ScriptRecorder.Step, timeoutMs = 80): Promise<[boolean, string | undefined]> {
  let message: string | undefined
  const ok = await new ScriptPlayer(session, { elementTimeoutMs: timeoutMs, pollMs: 10 }).run([step], (_i, s, m) => {
    if (s === ScriptPlayer.State.FAILED) message = m
  })
  return [ok, message]
}

describe('WaitsAndFillTest', () => {
  it('generated code for hidden, waits and count', () => {
    const root = screen(button('Item', 100), button('Item', 200), button('Item', 300))
    const picked = new ScriptRecorder('IOS').pick(root, 100, 120)!
    expect(picked.matchCount).toBe(3)
    const r = new ScriptRecorder('IOS')
    r.add(picked.target, Assertion.Hidden)
    r.add(picked.target, new WaitUntil(WaitState.VISIBLE))
    r.add(picked.target, new WaitUntil(WaitState.DISABLED))
    r.add(picked.target, new CountIs(3))
    expect(r.code().split(/\r?\n/)).toEqual([
      "await expect(screen.getByRole('button', { name: 'Item' }).nth(0)).toBeHidden();",
      "await screen.getByRole('button', { name: 'Item' }).nth(0).waitFor({ state: 'visible' });",
      "await screen.getByRole('button', { name: 'Item' }).nth(0).waitFor({ state: 'disabled' });",
      "await expect(screen.getByRole('button', { name: 'Item' })).toHaveCount(3);",
    ])
  })

  it('menu offers hidden and waits always and count only for repeated elements', () => {
    const root = screen(button('Item', 100), button('Item', 200), button('Solo', 300))
    const rec = new ScriptRecorder('IOS')
    const first = rec.pick(root, 100, 120)!
    const repeated = Checks.optionsFor(first.node, rec.pick(root, 100, 120)!.matchCount).map((it) => it.label)
    expect(repeated.includes('Becomes hidden')).toBe(true)
    expect(repeated.filter((it) => it.startsWith('Wait'))).toEqual(['Wait until visible', 'Wait until hidden', 'Wait until enabled', 'Wait until disabled'])
    expect(repeated[repeated.length - 1]).toBe('Count of matching elements = 2')
    const solo = rec.pick(root, 100, 320)!
    expect(solo.matchCount).toBe(1)
    expect(Checks.optionsFor(solo.node, solo.matchCount).every((it) => !(it instanceof CountIs))).toBe(true)
  })

  it('hidden passes for a missing element and fails with visible otherwise', async () => {
    const withButton = screen(button('Go', 100))
    const step = new ScriptRecorder.Expect(targetAt(withButton, 120), Assertion.Hidden)
    expect((await run(new FakeSession(() => screen()), step))[0]).toBe(true)
    expect((await run(new FakeSession(() => screen(button('Go', 100, false))), step))[0]).toBe(true)
    const [ok, message] = await run(new FakeSession(() => withButton), step)
    expect(ok).toBe(false)
    expect(message!.includes('becomes hidden') && message!.includes('was visible')).toBe(true)
    // Other assertions still need the element.
    expect((await run(new FakeSession(() => screen()), new ScriptRecorder.Expect(targetAt(withButton, 120), Assertion.Visible)))[0]).toBe(false)
  })

  it('wait states follow mobilewright checkState', () => {
    const find = (root: UiNode) => [...root.walk()].find((it) => it.type === 'Button')!
    const visibleEnabled = find(screen(button('Go', 100)))
    const disabled = find(screen(button('Go', 100, true, false)))
    const invisible = find(screen(button('Go', 100, false)))
    expect(WaitState.VISIBLE.holds(visibleEnabled)).toBe(true)
    expect(WaitState.VISIBLE.holds(undefined)).toBe(false)
    expect(WaitState.VISIBLE.holds(invisible)).toBe(false)
    expect(WaitState.HIDDEN.holds(undefined)).toBe(true)
    expect(WaitState.HIDDEN.holds(invisible)).toBe(true)
    expect(WaitState.HIDDEN.holds(visibleEnabled)).toBe(false)
    expect(WaitState.ENABLED.holds(visibleEnabled)).toBe(true)
    expect(WaitState.ENABLED.holds(undefined)).toBe(false)
    expect(WaitState.ENABLED.holds(disabled)).toBe(false)
    expect(WaitState.DISABLED.holds(disabled)).toBe(true)
    expect(WaitState.DISABLED.holds(undefined)).toBe(false)
    expect(WaitState.DISABLED.holds(visibleEnabled)).toBe(false)
  })

  it('waitFor polls until the state holds or times out', async () => {
    const withButton = screen(button('Go', 100))
    const target = targetAt(withButton, 120)
    let calls = 0
    const appearing = new FakeSession(() => (++calls < 4 ? screen() : withButton))
    expect((await run(appearing, new ScriptRecorder.WaitFor(target, WaitState.VISIBLE), 2000))[0]).toBe(true)
    calls = 0
    const vanishing = new FakeSession(() => (++calls < 4 ? withButton : screen()))
    expect((await run(vanishing, new ScriptRecorder.WaitFor(target, WaitState.HIDDEN), 2000))[0]).toBe(true)
    const [ok, message] = await run(new FakeSession(() => screen()), new ScriptRecorder.WaitFor(target, WaitState.DISABLED))
    expect(ok).toBe(false)
    expect(message!.includes('to be disabled') && message!.includes('element not found')).toBe(true)
  })

  it('count assertion counts all matches and retries', async () => {
    const three = screen(button('Item', 100), button('Item', 200), button('Item', 300))
    const target = new ScriptRecorder('IOS').pick(three, 100, 120)!.target
    expect((await run(new FakeSession(() => three), new ScriptRecorder.ExpectCount(target, 3)))[0]).toBe(true)
    let calls = 0
    const growing = new FakeSession(() => (++calls < 3 ? screen(button('Item', 100), button('Item', 200)) : three))
    expect((await run(growing, new ScriptRecorder.ExpectCount(target, 3), 2000))[0]).toBe(true)
    const [ok, message] = await run(new FakeSession(() => three), new ScriptRecorder.ExpectCount(target, 2))
    expect(ok).toBe(false)
    expect(message!.includes('2 elements') && message!.includes('was 3')).toBe(true)
  })

  it('clear keys differ per platform', () => {
    expect(TextClearing.keysFor('ANDROID')).toEqual(['ctrl+a', 'backspace'])
    expect(TextClearing.keysFor('IOS')).toEqual(['cmd+a', 'backspace'])
  })

  it('fill clears the field in one key call before typing', async () => {
    let value: string | null = 'old text'
    const session = new FakeSession(() => screen(field(value)), 'IOS', () => {
      value = null
    })
    const target = targetAt(screen(field('x')), 220)
    expect((await run(session, new ScriptRecorder.Fill(target, 'new')))[0]).toBe(true)
    expect(session.actions).toEqual(['tap 170,222', 'keys cmd+a backspace', 'type new'])
  })

  it('fill uses ctrl+a on android devices', async () => {
    const session = new FakeSession(() => screen(field(null)), 'ANDROID')
    expect((await run(session, new ScriptRecorder.Fill(targetAt(screen(field('x')), 220), 'new')))[0]).toBe(true)
    expect(session.actions[1]).toBe('keys ctrl+a backspace')
  })

  it('fill fails and does not type when the field keeps its text', async () => {
    const session = new FakeSession(() => screen(field('old text')))
    const [ok, message] = await run(session, new ScriptRecorder.Fill(targetAt(screen(field('x')), 220), 'new'))
    expect(ok).toBe(false)
    expect(message!.includes('Failed to clear element')).toBe(true)
    expect(session.actions.every((it) => !it.startsWith('type'))).toBe(true)
  })

  it('fill fails clearly when the connection cannot press keys', async () => {
    class NoKeys extends FakeSession {
      override async pressKeys(_keys: string[]): Promise<void> {
        throw new UnsupportedOperationOnDevice('no keys here')
      }
    }
    const session = new NoKeys(() => screen(field(null)))
    const [ok, message] = await run(session, new ScriptRecorder.Fill(targetAt(screen(field('x')), 220), 'new'))
    expect(ok).toBe(false)
    expect(message!.includes('no keys here')).toBe(true)
  })

  const androidField = (text: string, hint: string | null) =>
    new UiNode('ANDROID', 'android.widget.EditText', { text, ...(hint !== null ? { hint } : {}), class: 'android.widget.EditText' }, undefined)

  it('android text equal to the hint counts as an empty field', () => {
    // uiautomator reports the hint in text when the field is empty
    const session = new FakeSession(() => screen(field(null)), 'ANDROID')
    const player = new ScriptPlayer(session, { elementTimeoutMs: 80, pollMs: 10 })
    // Kotlin reads the private method through reflection; here it is reached through a cast.
    const isEmptyField = (n: UiNode): boolean => (player as unknown as { isEmptyField(n: UiNode): boolean }).isEmptyField(n)
    expect(isEmptyField(androidField('Text Field', 'Text Field'))).toBe(true)
    expect(isEmptyField(androidField('', null))).toBe(true)
    expect(isEmptyField(androidField('old', 'Text Field'))).toBe(false)
  })
})
