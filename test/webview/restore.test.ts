// @vitest-environment jsdom
// The host sends `device` before `restore`: restore opens the saved tool tab, and a tab mounted without a device
// would say "Not connected" for good (Notifications has no deviceChanged).
import { beforeAll, describe, expect, it } from 'vitest'

const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }))
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeAll(async () => {
  const w = window as unknown as Record<string, unknown>
  w.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} })
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as never
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  w.createImageBitmap = async () => ({ close() {} })
  document.body.innerHTML = '<div id="app"></div>'
  await import('../../src/webview/mirror')
  await settle()
})

describe('restore after device', () => {
  it('mounts the saved tool tab with the device known', async () => {
    post({ type: 'device', device: { id: 'x', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', displayName: 'Pixel 9 [emulator]' } })
    post({
      type: 'restore',
      layout: { lastDeviceId: 'x', lastDeviceName: 'Pixel 9', inspectorOpen: false, toolsOpen: true, toolsTab: 'Notifications', mirrorProportion: 0.5, toolsProportion: 0.5 },
      showGrid: false,
      saveHierarchyWithScreenshot: false,
      elementFilter: '',
      locatorLanguage: 'MOBILEWRIGHT',
      locatorWholeLine: false,
    })
    await settle()
    const body = document.getElementById('tabbody')!.textContent
    expect(body).toContain('Send intent')
    expect(body).not.toContain('Not connected')
  })
})
