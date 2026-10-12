#!/usr/bin/env node
// Smoke test of the built viewer page (dist/webview/mirror.js) in jsdom: loads it, plays the first host messages and
// fails when any script error occurs or the toolbar stays empty. Run `npm run build` first.
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'

const errors = []
const sent = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push(e.detail?.stack ?? e.message))
vc.on('error', (e) => errors.push(String(e)))
const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc })
const w = dom.window
w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m.type), getState: () => undefined, setState: () => {} })
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
w.ResizeObserver = class { observe() {} disconnect() {} }
w.createImageBitmap = async () => ({ close() {} })
const post = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }))
const settle = () => new Promise((r) => setTimeout(r, 50))

try {
  w.eval(readFileSync('dist/webview/mirror.js', 'utf8'))
  await settle()
  post({ type: 'device', device: { id: 'x', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR', displayName: 'Pixel 9 [emulator]' } })
  post({ type: 'capabilities', capabilities: { supportsDoubleTap: true, supportsHoldDrag: true, transport: 'adb', transportTooltip: 'adb', logicalSize: { width: 1080, height: 2400 }, upright: false, longPressMs: 700 } })
  post({ type: 'status', message: 'adb screenshots', level: 'info' })
  await settle()
} catch (e) {
  errors.push(e.stack)
}

const toolbar = w.document.getElementById('toolbar')?.children.length ?? 0
const tabs = w.document.getElementById('tabs')?.children.length ?? 0
console.log(`toolbar buttons: ${toolbar}, tool tabs: ${tabs}, messages to host: ${sent.join(',')}`)
const inspectorTabs = [...w.document.querySelectorAll('.mtb-itabs button')].map((b) => b.textContent)
console.log(`inspector tabs: ${inspectorTabs.join(', ')}`)
for (const t of ['Elements', 'Locators', 'Recorder']) if (!inspectorTabs.includes(t)) errors.push(`The inspector has no ${t} tab`)
if (toolbar === 0) errors.push('The toolbar is empty')
if (!sent.includes('ready')) errors.push('The page never sent "ready" to the host')
if (errors.length) {
  console.error(errors.join('\n---\n'))
  process.exit(1)
}
console.log('webview smoke test passed')
process.exit(0)
