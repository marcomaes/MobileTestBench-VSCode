// ported-from: ui/CrashesPanel.kt
// Webview half of the Crashes tab: a filterable list (newest first) and the report of the selected crash.
import { Crashes, type CrashEntry } from '../../core/crashes/crashes'
import type { ToolApi, ToolView } from '../toolApi'
import { button, copyText, h, injectToolStyles, input, row, table } from '../ui'

// One webview page is one device viewer: the loader is kept here so `shown` can reach the mounted tab.
let loadIfEmpty: (() => void) | undefined

export const crashesView: ToolView = {
  id: 'crashes',
  title: 'Crashes',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    let all: CrashEntry[] = []
    let shownEntries: CrashEntry[] = []
    let selectedId: string | undefined
    let report = ''
    let displayedId: string | undefined
    let listGeneration = 0
    let reportGeneration = 0

    const filter = input('', { placeholder: 'Filter by process, id or time', size: 22 })
    const note = h('span', { class: 'mtb-muted' })
    const status = h('div', { class: 'mtb-msg' }, api.device ? '' : 'Not connected')
    const summary = h('div', { style: 'font-weight:700;color:var(--vscode-errorForeground);min-height:1.2em' })
    const text = h('div', { class: 'mtb-code', style: 'max-height:300px;overflow:auto' })
    const copy = button('Copy', () => void copyText(report))
    const save = button('Save...', () => void saveReport())
    copy.disabled = true
    save.disabled = true
    const listBox = h('div', { style: 'max-height:300px;overflow:auto;flex:0 0 42%' })

    const setStatus = (t: string, error = false) => {
      status.className = error ? 'mtb-msg err' : 'mtb-msg'
      status.textContent = t
    }

    function showReport(summaryText: string | undefined, content: string, available = false): void {
      report = available ? content : ''
      summary.textContent = summaryText ?? ' '
      text.textContent = content
      text.scrollTop = 0
      copy.disabled = !available
      save.disabled = !available
    }

    function clearReport(): void {
      reportGeneration++
      displayedId = undefined
      showReport(undefined, '')
    }

    function renderList(): void {
      const t = table(
        ['Time', 'Process / app', 'Id'],
        shownEntries.map((e) => [e.timestamp, e.process, e.id]),
        (i, tr) => {
          const e = shownEntries[i]
          if (e.id === selectedId) tr.classList.add('sel')
          tr.addEventListener('click', () => {
            selectedId = e.id
            listBox.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'))
            tr.classList.add('sel')
            void loadSelected()
          })
        },
      )
      listBox.replaceChildren(t)
    }

    function applyFilter(): void {
      const keep = selectedId
      shownEntries = Crashes.filter(all, filter.value)
      // Keep the selected crash (and its open report) if it is still listed.
      if (keep !== undefined && !shownEntries.some((e) => e.id === keep)) selectedId = undefined
      renderList()
      if (selectedId === undefined && (keep !== undefined || shownEntries.length === 0)) clearReport()
    }

    async function refresh(): Promise<void> {
      if (!api.device) return
      const gen = ++listGeneration
      setStatus('Loading crash reports...')
      try {
        const r = await api.request<{ entries: CrashEntry[]; note: string }>('list')
        if (gen !== listGeneration) return
        all = r.entries
        note.textContent = r.note
        applyFilter()
        setStatus(all.length === 0 ? 'No crash reports' : `${all.length} crash reports`)
      } catch (e) {
        if (gen === listGeneration) setStatus(`Could not list crash reports: ${(e as Error).message}`, true)
      }
    }

    /** Fetches the full report of the selected row. */
    async function loadSelected(): Promise<void> {
      const entry = shownEntries.find((e) => e.id === selectedId)
      if (!entry) return clearReport()
      if (entry.id === displayedId) return
      displayedId = entry.id
      const gen = ++reportGeneration
      showReport(undefined, `Loading ${entry.id}...`)
      try {
        const r = await api.request<{ content: string; summary: string }>('get', { id: entry.id })
        if (gen === reportGeneration) showReport(r.summary || undefined, r.content, true)
      } catch (e) {
        if (gen !== reportGeneration) return
        displayedId = undefined
        showReport(undefined, `Could not load the report: ${(e as Error).message}`)
      }
    }

    async function saveReport(): Promise<void> {
      const entry = shownEntries.find((e) => e.id === selectedId)
      if (!entry) return
      const r = await api.request<string>('save', { entry, content: report }).catch((e: Error) => e.message)
      if (r) setStatus(r)
    }

    filter.addEventListener('input', applyFilter)
    root.append(
      row(button('Refresh', () => void refresh()), filter, note),
      h('div', { style: 'display:flex;gap:8px;align-items:flex-start' }, listBox, h('div', { style: 'flex:1;min-width:0' }, row(copy, save), summary, text)),
      status,
    )
    loadIfEmpty = () => {
      if (api.device && all.length === 0) void refresh()
    }
  },

  shown() {
    loadIfEmpty?.()
  },
}
