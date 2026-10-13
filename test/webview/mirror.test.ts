// @vitest-environment jsdom
// The viewer page in jsdom: host messages in, page messages out. Covers the page half of the host/webview protocol.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToHost } from '../../src/protocol'

const sent: ToHost[] = []
const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }))
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeAll(async () => {
  const w = window as unknown as Record<string, unknown>
  w.acquireVsCodeApi = () => ({ postMessage: (m: ToHost) => sent.push(m), getState: () => undefined, setState: () => {} })
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as never
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  w.createImageBitmap = async () => ({ close() {} })
  document.body.innerHTML = '<div id="app"></div>'
  await import('../../src/webview/mirror')
  await settle()
  post({ type: 'device', device: { id: 'x', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', displayName: 'Pixel 9 [emulator]' } })
  post({
    type: 'capabilities',
    capabilities: { supportsDoubleTap: true, supportsHoldDrag: true, transport: 'adb', transportTooltip: 'adb', logicalSize: { width: 1080, height: 2400 }, upright: false, longPressMs: 700 },
  })
  await settle()
})

describe('viewer page', () => {
  it('tells the host it is ready exactly once', () => {
    expect(sent.filter((m) => m.type === 'ready')).toHaveLength(1)
  })

  it('builds the toolbar, the tool tabs and the inspector tabs', () => {
    expect(document.getElementById('toolbar')!.children.length).toBeGreaterThan(0)
    expect(document.getElementById('tabs')!.children.length).toBeGreaterThan(0)
    const tabs = [...document.querySelectorAll('.mtb-itabs button')].map((b) => b.textContent)
    expect(tabs).toEqual(expect.arrayContaining(['Elements', 'Locators', 'Recorder']))
  })

  it('shows a status message from the host', async () => {
    post({ type: 'status', message: 'adb screenshots', level: 'info' })
    await settle()
    expect(document.body.textContent).toContain('adb screenshots')
  })

  it('shows an error status from the host', async () => {
    post({ type: 'status', message: 'Screen recording failed: boom', level: 'error' })
    await settle()
    expect(document.body.textContent).toContain('Screen recording failed: boom')
  })

  it('ignores unknown and malformed host messages without throwing', async () => {
    const errors = vi.fn()
    window.addEventListener('error', errors)
    post({ type: 'does-not-exist' })
    post({})
    post(null)
    post('text')
    await settle()
    window.removeEventListener('error', errors)
    expect(errors).not.toHaveBeenCalled()
  })
})
