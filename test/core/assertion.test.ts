// ported-from: test:core/AssertionTest.kt
import { describe, expect, it } from 'vitest'
import { WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { UiNode } from '../../src/core/inspector/uiNode'
import { makeDevice, rect, type DeviceKey, type Platform, type Size } from '../../src/core/model'
import { Assertion } from '../../src/core/recording/assertion'
import { ScriptPlayer } from '../../src/core/recording/scriptPlayer'
import { ScriptRecorder } from '../../src/core/recording/scriptRecorder'
import { BaseDeviceSession, type FrameListener } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

const node = (platform: Platform, type: string, attrs: Record<string, string>) => new UiNode(platform, type, { ...attrs, visible: 'true' }, rect(0, 0, 100, 40))

class FakeSession extends BaseDeviceSession {
  readonly device = makeDevice({ id: 'sim', name: 'Sim', platform: 'IOS', kind: 'SIMULATOR' })
  readonly transport = 'fake'
  readonly supportsInput = true
  constructor(private readonly screens: () => UiNode) {
    super()
  }
  start(_listener: FrameListener): void {}
  logicalSize(): Size {
    return { width: 400, height: 800 }
  }
  async tap(_x: number, _y: number): Promise<void> {}
  async swipe(_fromX: number, _fromY: number, _toX: number, _toY: number): Promise<void> {}
  async press(_key: DeviceKey): Promise<void> {}
  async typeText(_text: string): Promise<void> {}
  async hierarchy(): Promise<UiNode> {
    return this.screens()
  }
  close(): void {}
}

const expectStep = (assertion: Assertion): ScriptRecorder.Step => {
  const target = new ScriptRecorder('IOS').pick(ios, 100, 220)!.target
  return new ScriptRecorder.Expect(target, assertion)
}

describe('AssertionTest', () => {
  it('options depend on the element', () => {
    const label = node('IOS', 'XCUIElementTypeStaticText', { label: 'Welcome back, Marco' })
    expect(Assertion.optionsFor(label).map((it) => it.label)).toEqual(['Is visible', "Has text 'Welcome back, Marco'", "Contains text 'Welcome back'", 'Is enabled'])
    const field = node('ANDROID', 'android.widget.EditText', { text: 'marco@example.com', enabled: 'true' })
    expect(Assertion.optionsFor(field).map((it) => it.label)).toEqual(['Is visible', "Has value 'marco@example.com'", 'Is enabled'])
    const toggle = node('IOS', 'XCUIElementTypeSwitch', { value: '1', label: 'Grid', enabled: 'false' })
    expect(Assertion.optionsFor(toggle).map((it) => it.label)).toEqual(['Is visible', "Has text 'Grid'", 'Is disabled', 'Is checked'])
  })

  it('assertions are written as mobilewright matchers', () => {
    expect(Assertion.Visible.matcher()).toBe('.toBeVisible()')
    expect(new Assertion.HasText("it's").matcher()).toBe(".toHaveText('it\\'s')")
    expect(new Assertion.ContainsText('a').matcher()).toBe(".toContainText('a')")
    expect(new Assertion.HasValue('x').matcher()).toBe(".toHaveValue('x')")
    expect(new Assertion.Enabled(true).matcher()).toBe('.toBeEnabled()')
    expect(new Assertion.Enabled(false).matcher()).toBe('.toBeDisabled()')
    expect(Assertion.Checked.matcher()).toBe('.toBeChecked()')
  })

  it('the recorder picks the element and records an expect step', () => {
    const r = new ScriptRecorder('IOS')
    const picked = r.pick(ios, 100, 220)! // email text field
    r.expect(picked.target, Assertion.Visible)
    expect(r.code()).toBe("await expect(screen.getByTestId('email-input')).toBeVisible();")
    expect(Assertion.optionsFor(picked.node)).toBeDefined()
    expect(r.pick(ios, 5000, 5000)).toBeUndefined()
  })

  it('replay passes when the assertion holds, retries, and fails with what it found', async () => {
    const player = new ScriptPlayer(new FakeSession(() => ios), { elementTimeoutMs: 80, pollMs: 10 })
    expect(await player.run([expectStep(Assertion.Visible)], () => {})).toBe(true)
    expect(await player.run([expectStep(new Assertion.HasText('Email'))], () => {})).toBe(true)

    let message: string | undefined
    expect(
      await player.run([expectStep(new Assertion.HasText('Wrong'))], (_i, s, m) => {
        if (s === ScriptPlayer.State.FAILED) message = m
      }),
    ).toBe(false)
    expect(message!.includes("has text 'Wrong'") && message!.includes("was 'Email'")).toBe(true)

    let calls = 0
    const late = new UiNode('IOS', 'XCUIElementTypeApplication', {}, undefined)
    const retrying = new ScriptPlayer(new FakeSession(() => (++calls < 3 ? late : ios)), { elementTimeoutMs: 2000, pollMs: 10 })
    expect(await retrying.run([expectStep(Assertion.Visible)], () => {})).toBe(true)
  })
})
