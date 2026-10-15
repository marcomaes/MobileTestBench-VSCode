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
    expect(document.querySelectorAll('#toolbar .grp').length).toBe(4)
    expect(document.querySelectorAll('#toolbar button').length).toBeGreaterThan(15)
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

describe('element tree', () => {
  it('keeps its grid column no wider than the pane, so the tree itself scrolls sideways', async () => {
    const { inspectorCss } = await import('../../src/webview/inspector')
    expect(inspectorCss).toMatch(/\.mtb-ielements\.on \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
    expect(inspectorCss).toMatch(/\.mtb-itreewrap \{[^}]*min-width: 0/)
  })

  it('selecting a row scrolls only the tree, vertically', async () => {
    const { createInspector, nodeFromDto } = await import('../../src/webview/inspector')
    const host = document.createElement('div')
    document.body.append(host)
    const inspector = createInspector(host)
    const leaf = { platform: 'ANDROID' as const, rawType: 'Button', attributes: { text: 'x'.repeat(400) }, bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }
    const root = nodeFromDto({ platform: 'ANDROID', rawType: 'FrameLayout', attributes: {}, bounds: { x: 0, y: 0, width: 10, height: 10 }, children: [leaf] })
    inspector.setHierarchy(root)
    const rows = host.querySelectorAll<HTMLElement>('.mtb-irow')
    const scrollIntoView = vi.fn()
    for (const r of rows) r.scrollIntoView = scrollIntoView
    inspector.select(root.children[0])
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect((host.querySelector('.mtb-itree') as HTMLElement).scrollLeft).toBe(0)
  })
})

describe('locators tab', () => {
  it('shows the hint of a warned locator in a tooltip when the pointer rests on its row', async () => {
    const { createInspector, nodeFromDto } = await import('../../src/webview/inspector')
    const host = document.createElement('div')
    document.body.append(host)
    const inspector = createInspector(host)
    const leaf = { platform: 'ANDROID' as const, rawType: 'android.view.ViewGroup', attributes: { 'resource-id': 'item-1' }, bounds: { x: 0, y: 0, width: 5, height: 5 }, children: [] }
    const root = nodeFromDto({ platform: 'ANDROID', rawType: 'android.widget.FrameLayout', attributes: {}, bounds: { x: 0, y: 0, width: 10, height: 10 }, children: [leaf] })
    const { toolViews } = await import('../../src/webview/tools')
    const view = toolViews.find((v) => v.id === 'locators')!
    const el = document.createElement('div')
    const api = { device: undefined, capabilities: undefined, request: async () => ({}), on: () => () => {}, hierarchy: () => undefined, highlight: () => {}, status: () => {}, viewer: { inspector, setCopyOptions: () => {}, setRecording: () => {}, setPicker: () => {} } }
    document.body.append(el)
    view.mount(el, api as never)
    inspector.setHierarchy(root)
    inspector.select(root.children[0])
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('.mtb-table tbody tr')]
    const warned = rows.filter((r) => r.textContent?.includes('⚠'))
    expect(warned.length).toBeGreaterThan(0)
    for (const r of warned) expect(r.dataset.tip).toBeTruthy()
    vi.useFakeTimers()
    try {
      warned[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      expect(document.querySelector('.mtb-tip')).toBeNull()
      vi.advanceTimersByTime(250)
      expect(document.querySelector('.mtb-tip')?.textContent).toBe(warned[0].dataset.tip)
      warned[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      expect(document.querySelector('.mtb-tip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
