// ported-from: ui/RecorderPanel.kt
// The Recorder tab (webview half): the record toggle, Assert, the Output combo, Copy, Insert at Caret, Clear, the step list with
// replay (all, from a step, the selected ones), scroll until visible and per step timeouts. The steps, the recording and the replay
// live in the host (src/extension/recorderController.ts); this half draws the view it sends and calls its methods.
// What differs from the Kotlin panel: the Record toggle is in this tab (not in the viewer toolbar) and the step menu is a button row.
import type { RecorderView } from '../../extension/recorderController'
import type { ToolApi, ToolView } from '../toolApi'
import { button, copyText, h, messageLine, select } from '../ui'

const ICONS: Record<string, string> = { RUNNING: '▶', PASSED: '✓', FAILED: '✗', SKIPPED: '–' }
const SCROLL_TEXT = 'Scroll until the next element is visible'

function mount(root: HTMLElement, api: ToolApi): { deviceChanged(connected: boolean): void } {
  let view: RecorderView | undefined
  const selected = new Set<number>()
  let anchor = 0

  const recordBtn = button('Record', () => void api.request('record', { on: !view?.recording }), { title: 'Record what you do on the device as test steps' })
  const assertBtn = button('Assert', () => void api.request('assert', { on: !view?.armed }), { title: 'Click an element on the screen to add an assertion about it' })
  const outputBox = select([{ value: 'MOBILEWRIGHT', label: 'Mobilewright' }], 'MOBILEWRIGHT', (v) => void api.request('output', { name: v }))
  outputBox.title = 'What the steps are written as. Replay is not affected.'
  const status = messageLine()
  const list = h('div', { class: 'mtb-code', style: 'white-space: normal; min-height: 4em; max-height: 40vh; overflow: auto; padding: 2px' })
  const rows = (): number[] => [...selected].sort((a, b) => a - b)

  const copyBtn = button('Copy', async () => {
    await copyText(await api.request<string>('code'))
    status.set('Copied')
  })
  const insertBtn = button('Insert at Caret', async () => status.set(await api.request<string>('insert')))
  const clearBtn = button('Clear', () => void api.request('clear'))
  const scrollBtn = button('Scroll Until Visible', () => void api.request('scroll', { rows: rows() }), { title: SCROLL_TEXT + ': select the swipe steps, then press' })
  const replayBtn = button('Replay', () => void api.request('replay'))
  const replayFromBtn = button('Replay from Step', () => void api.request('replayFrom', { rows: rows() }), { title: 'Replays the selected step and everything after it' })
  const replaySelectedBtn = button('Replay Selected', () => void api.request('replaySelected', { rows: rows() }), { title: 'Replays only the selected steps' })
  const stopBtn = button('Stop', () => void api.request('stopReplay'))
  const timeoutBtn = button('Set timeout...', () => void api.request('timeout', { rows: rows() }), { title: 'Own timeout for the selected wait and expect steps' })
  const scrollOptionsBtn = button('Scroll direction and limit...', () => void api.request('scrollOptions', { rows: rows() }))

  function render(): void {
    const v = view
    if (!v) return
    const steps = v.rows
    for (const i of [...selected]) if (i >= steps.length) selected.delete(i)
    const picked = rows().map((i) => steps[i])
    const some = picked.length > 0
    recordBtn.textContent = v.recording ? 'Stop recording' : 'Record'
    recordBtn.style.background = v.recording ? 'var(--vscode-statusBarItem-errorBackground, #c72e0f)' : ''
    recordBtn.disabled = v.replaying
    assertBtn.disabled = !v.recording
    assertBtn.style.outline = v.armed ? '2px solid var(--vscode-focusBorder)' : ''
    outputBox.replaceChildren(...v.outputs.map((o) => h('option', { value: o.value }, o.label)))
    outputBox.value = v.output
    // The mirror acts on the device while recording, and an armed Assert picks instead of tapping.
    api.viewer.setRecording(v.recording)
    api.viewer.setPicker(v.armed ? (x, y) => void api.request('pick', { x, y }) : undefined)
    replayBtn.style.display = replayFromBtn.style.display = replaySelectedBtn.style.display = v.replaying ? 'none' : ''
    stopBtn.style.display = v.replaying ? '' : 'none'
    replayBtn.disabled = !v.canReplay
    replayFromBtn.disabled = replaySelectedBtn.disabled = !(v.canReplay && some)
    scrollBtn.disabled = !(!v.replaying && some && picked.every((r) => r.isSwipe))
    scrollOptionsBtn.disabled = !(!v.replaying && some && picked.every((r) => r.isScroll))
    timeoutBtn.disabled = !(!v.replaying && some && picked.every((r) => r.supportsTimeout))
    status.set(v.message.trim() === '' ? ' ' : v.message)
    list.replaceChildren(
      ...(steps.length === 0
        ? [h('div', { class: 'mtb-muted' }, v.recording ? 'Recording: tap, swipe and type on the device' : 'Press Record, then use the device')]
        : steps.map((r, i) => {
            const line = h('div', { style: 'white-space: pre; cursor: pointer; padding: 0 2px' }, `${r.state ? ICONS[r.state] : ' '} ${r.text}`)
            if (r.state === 'FAILED') line.style.color = 'var(--vscode-errorForeground)'
            if (r.state === 'SKIPPED') line.style.opacity = '.6'
            if (r.state === 'RUNNING') line.style.fontWeight = '600'
            if (selected.has(i)) {
              line.style.background = 'var(--vscode-list-activeSelectionBackground)'
              line.style.color = 'var(--vscode-list-activeSelectionForeground)'
            }
            line.onclick = (e) => {
              if (e.shiftKey) {
                selected.clear()
                for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(k)
              } else if (e.metaKey || e.ctrlKey) {
                if (!selected.delete(i)) selected.add(i)
                anchor = i
              } else {
                selected.clear()
                selected.add(i)
                anchor = i
              }
              render()
            }
            return line
          })),
    )
    if (v.recording && steps.length > 0) list.lastElementChild?.scrollIntoView({ block: 'nearest' })
    if (v.replaying) {
      const running = steps.findIndex((r) => r.state === 'RUNNING')
      if (running >= 0) list.children[running]?.scrollIntoView({ block: 'nearest' })
    }
  }

  api.on('state', (data) => {
    view = data as RecorderView
    render()
  })
  root.append(
    h('div', { class: 'mtb-row' }, recordBtn, assertBtn, h('span', {}, 'Output:'), outputBox, copyBtn, insertBtn, clearBtn, scrollBtn),
    h('div', { class: 'mtb-row' }, replayBtn, replayFromBtn, replaySelectedBtn, stopBtn, timeoutBtn, scrollOptionsBtn),
    list,
    status,
  )
  void api.request<RecorderView>('state').then((v) => {
    view = v
    render()
  })
  render()

  return {
    deviceChanged(connected) {
      // A session that ends ends the recording (the Kotlin viewer stops it when the device goes).
      if (!connected && view?.recording) void api.request('stop')
    },
  }
}

let instance: ReturnType<typeof mount> | undefined

export const recorderView: ToolView = {
  id: 'recorder',
  title: 'Recorder',
  mount(root, api) {
    instance = mount(root, api)
  },
  deviceChanged: (device) => instance?.deviceChanged(device !== undefined),
}
