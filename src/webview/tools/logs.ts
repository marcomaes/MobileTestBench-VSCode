// ported-from: ui/LogPanel.kt
// Webview half of the Log tab: the list (virtual rows), the filter, highlighting and pause. The host half streams the entries.
import { LogEntry, LogFilter, LogLevel, logLevelLabel, logLevelName } from '../../core/logs/logs'
import type { ToolApi, ToolView } from '../toolApi'
import { button, checkbox, copyText, h, injectToolStyles, input, select } from '../ui'

/** How many lines are kept: the oldest go first. */
const MAX_ENTRIES = 20_000
const ROW_HEIGHT = 18
const DRAIN_MS = 200
const PID_MS = 3000

interface EntryDto {
  time: string
  level: LogLevel
  tag: string
  pid: string
  message: string
}

const CSS = `
.mtb-log-view { position: relative; height: 260px; overflow: auto; resize: vertical; border: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); font-size: 12px; }
.mtb-log-rows { position: absolute; left: 0; right: 0; }
.mtb-log-row { display: grid; grid-template-columns: 135px 18px 150px 1fr; gap: 6px; height: ${ROW_HEIGHT}px; line-height: ${ROW_HEIGHT}px; white-space: pre; overflow: hidden; padding: 0 4px; cursor: default; }
.mtb-log-row > span { overflow: hidden; text-overflow: ellipsis; }
.mtb-log-row:hover { background: var(--vscode-list-hoverBackground); }
.mtb-log-row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.mtb-log-row.lvl-4, .mtb-log-row.lvl-5 { color: var(--vscode-errorForeground); }
.mtb-log-row.lvl-3 { color: var(--vscode-editorWarning-foreground); }
.mtb-log-row.lvl-0, .mtb-log-row.lvl-1 { color: var(--vscode-disabledForeground); }
.mtb-log-row.sel { color: var(--vscode-list-activeSelectionForeground); }
.mtb-log-row mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
.mtb-log-menu { position: fixed; z-index: 10; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); padding: 2px 0; }
.mtb-log-menu div { padding: 2px 14px; cursor: pointer; } .mtb-log-menu div:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.mtb-log-menu div.off { opacity: .5; pointer-events: none; }
.mtb-input.bad { outline: 1px solid var(--vscode-inputValidation-errorBorder); }
.mtb-toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
`

export const logsView: ToolView = {
  id: 'logs',
  title: 'Log',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    root.append(h('style', {}, CSS))

    const level = select(
      [LogLevel.VERBOSE, LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL].map((l) => ({ value: String(l), label: logLevelLabel(l) })),
      String(LogLevel.INFO),
    )
    const text = input('', { placeholder: 'Message contains', size: 16 })
    const tag = input('', { placeholder: 'Tag / process', size: 12 })
    const app = input('', { placeholder: 'App (package or process)', size: 18 })
    const regexToggle = button('.*', () => {
      regexOn = !regexOn
      regexToggle.classList.toggle('on', regexOn)
      filterChanged()
    }, { title: 'Regular expressions (case-insensitive) for the message and tag filters', class: 'mtb-btn mtb-toggle' })
    const restart = button('Restart app', () => restartApp(), { title: 'Terminate and relaunch the app in the App field (a package or bundle id) and clear the list, to catch the first lines of its start' })
    restart.disabled = true
    const pauseToggle = button('Pause', () => {
      paused = !paused
      pauseToggle.classList.toggle('on', paused)
    }, { class: 'mtb-btn mtb-toggle' })
    let autoScroll = true
    const status = h('div', { class: 'mtb-msg' }, 'Not started')

    let regexOn = false
    let paused = false
    let baseStatus = ''
    let filter = new LogFilter()
    let appPids: Set<string> | undefined
    let pidTimer: ReturnType<typeof setInterval> | undefined
    let restartGeneration = 0

    /** Everything received (capped), and the part of it that passes the filter. */
    let all: LogEntry[] = []
    let view: LogEntry[] = []
    let incoming: LogEntry[] = []
    const selected = new Set<LogEntry>()
    let anchor: LogEntry | undefined

    const isAndroid = () => api.device?.platform === 'ANDROID'
    const isIos = () => api.device?.platform === 'IOS'

    // ---- list (virtual rows)
    const viewport = h('div', { class: 'mtb-log-view', tabindex: 0 })
    const spacer = h('div', {})
    const rowsEl = h('div', { class: 'mtb-log-rows' })
    viewport.append(spacer, rowsEl)

    const rowEntries = new Map<Element, LogEntry>()
    /** Updates the selection marks in place: re-creating the rows on mouse down would swallow the double click. */
    const markSelection = (): void => rowEntries.forEach((e, row) => row.classList.toggle('sel', selected.has(e)))

    const shownLine = (e: LogEntry): string => e.message.split(/\r\n|\n|\r/)[0].replaceAll('\t', '    ') + (e.message.includes('\n') ? '  [...]' : '')

    function messageNode(e: LogEntry): HTMLElement {
      const line = shownLine(e)
      const ranges = filter.matchRanges(line)
      const span = h('span', {})
      let at = 0
      for (const r of ranges) {
        if (r.last >= line.length) continue
        if (r.first > at) span.append(line.slice(at, r.first))
        span.append(h('mark', {}, line.slice(r.first, r.last + 1)))
        at = r.last + 1
      }
      span.append(line.slice(at))
      return span
    }

    function renderRows(): void {
      spacer.style.height = `${view.length * ROW_HEIGHT}px`
      const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 5)
      const last = Math.min(view.length, first + Math.ceil(viewport.clientHeight / ROW_HEIGHT) + 10)
      rowsEl.style.top = `${first * ROW_HEIGHT}px`
      rowsEl.replaceChildren()
      rowEntries.clear()
      for (let i = first; i < last; i++) {
        const e = view[i]
        const row = h(
          'div',
          { class: `mtb-log-row lvl-${e.level}${selected.has(e) ? ' sel' : ''}`, title: e.message.length > 200 ? e.message.slice(0, 600) : e.message },
          h('span', {}, e.time),
          h('span', {}, logLevelName(e.level)[0]),
          h('span', {}, e.tag),
          messageNode(e),
        )
        rowEntries.set(row, e)
        row.addEventListener('mousedown', (ev) => select_(e, ev))
        row.addEventListener('dblclick', () => void openInEditor(e))
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          if (!selected.has(e)) select_(e, ev)
          showMenu(ev.clientX, ev.clientY, e)
        })
        rowsEl.append(row)
      }
    }

    function select_(e: LogEntry, ev: MouseEvent): void {
      if (ev.button === 2 && selected.has(e)) return
      if (ev.shiftKey && anchor) {
        const a = view.indexOf(anchor)
        const b = view.indexOf(e)
        if (a >= 0 && b >= 0) {
          if (!(ev.ctrlKey || ev.metaKey)) selected.clear()
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(view[i])
        }
      } else if (ev.ctrlKey || ev.metaKey) {
        if (!selected.delete(e)) selected.add(e)
        anchor = e
      } else {
        selected.clear()
        selected.add(e)
        anchor = e
      }
      markSelection()
    }

    viewport.addEventListener('scroll', renderRows)
    viewport.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c') {
        ev.preventDefault()
        void copySelected()
      }
    })

    function scrollToEnd(): void {
      if (autoScroll && view.length > 0) viewport.scrollTop = view.length * ROW_HEIGHT
    }

    let menu: HTMLElement | undefined
    function closeMenu(): void {
      menu?.remove()
      menu = undefined
    }
    document.addEventListener('mousedown', (ev) => {
      if (menu && !menu.contains(ev.target as Node)) closeMenu()
    })
    function showMenu(x: number, y: number, e: LogEntry): void {
      closeMenu()
      const hasFrame = /\(([\w$-]+\.(?:java|kt|kts)):\d+\)/.test(e.message)
      menu = h(
        'div',
        { class: 'mtb-log-menu' },
        h('div', { class: hasFrame ? '' : 'off', onclick: () => (closeMenu(), void openInEditor(e)) }, 'Open in Editor'),
        h('div', { onclick: () => (closeMenu(), void copySelected()) }, 'Copy'),
      )
      menu.style.left = `${x}px`
      menu.style.top = `${y}px`
      document.body.append(menu)
    }

    // ---- data
    function receive(entries: EntryDto[]): void {
      for (const d of entries) incoming.push(new LogEntry(d.time, d.level, d.tag, d.pid, d.message))
      if (incoming.length > MAX_ENTRIES * 2) incoming = incoming.slice(incoming.length - MAX_ENTRIES * 2)
    }

    /** Moves what arrived into the list (not while paused). */
    function drain(): void {
      if (paused || incoming.length === 0) return
      let added = 0
      for (const e of incoming) {
        all.push(e)
        if (filter.matches(e)) {
          view.push(e)
          added++
        }
      }
      incoming = []
      if (all.length > MAX_ENTRIES) all = all.slice(all.length - MAX_ENTRIES)
      if (added === 0) return
      // The list is capped like the buffer, so the table stays fast.
      if (view.length > MAX_ENTRIES) view = view.slice(view.length - MAX_ENTRIES)
      renderRows()
      scrollToEnd()
      renderRows()
      updateCount()
    }

    function currentFilter(): LogFilter {
      // On Android an app is its process ids; until they are known nothing of the app can match.
      const pids = app.value.trim() && isAndroid() ? (appPids ?? new Set<string>()) : undefined
      return new LogFilter({ minLevel: Number(level.value) as LogLevel, text: text.value, tag: tag.value, app: app.value, appPids: pids, regex: regexOn, bundleIdLastPart: isIos() })
    }

    function filterChanged(): void {
      filter = currentFilter()
      showRegexErrors()
      restart.disabled = app.value.trim().length === 0
      // On Android an app is a set of process ids that changes when the app restarts: look them up now and every few seconds.
      if (isAndroid() && app.value.trim()) {
        pidTimer ??= setInterval(refreshPids, PID_MS)
        refreshPids()
      } else {
        if (pidTimer) clearInterval(pidTimer)
        pidTimer = undefined
        appPids = undefined
      }
      rebuild()
    }

    /** An invalid pattern is shown in red with the reason; it is ignored until it is fixed. */
    function showRegexErrors(): void {
      for (const [field, error] of [[text, filter.textError], [tag, filter.tagError]] as const) {
        field.classList.toggle('bad', error !== undefined)
        field.title = error !== undefined ? `Invalid regular expression: ${error}` : ''
      }
    }

    function refreshPids(): void {
      const name = app.value.trim()
      if (!name) return
      void api.request<string[]>('pids', { name }).then((list) => {
        const pids = new Set(list)
        const same = appPids && appPids.size === pids.size && [...pids].every((p) => appPids!.has(p))
        if (app.value.trim() === name && !same) {
          appPids = pids
          filter = currentFilter()
          rebuild()
        }
      }, () => undefined)
    }

    function rebuild(): void {
      view = all.filter((e) => filter.matches(e))
      renderRows()
      scrollToEnd()
      renderRows()
      updateCount()
    }

    function updateCount(): void {
      status.className = 'mtb-msg'
      status.textContent =
        `${baseStatus}  |  ${view.length} of ${all.length} lines` +
        (app.value.trim() && filter.appPids?.size === 0 ? '  |  the app is not running' : '') +
        (filter.textError ? `  |  Invalid message regex (ignored): ${filter.textError}` : '') +
        (filter.tagError ? `  |  Invalid tag regex (ignored): ${filter.tagError}` : '')
    }

    function setStatus(textValue: string): void {
      baseStatus = textValue
      updateCount()
    }

    function clear(): void {
      all = []
      view = []
      incoming = []
      selected.clear()
      renderRows()
      updateCount()
    }

    async function copySelected(): Promise<void> {
      const rows = view.filter((e) => selected.has(e))
      if (rows.length > 0) await copyText(rows.map(String).join('\n'))
    }

    async function openInEditor(e: LogEntry): Promise<void> {
      setStatus(await api.request<string>('open', { message: e.message }).catch((err: Error) => err.message))
    }

    /**
     * Terminates and relaunches the app of the App filter and empties the list first, so the lines of the start are captured.
     * The log stream keeps running.
     */
    async function restartApp(): Promise<void> {
      const name = app.value.trim()
      if (!name) return
      const generation = ++restartGeneration
      paused = false
      pauseToggle.classList.remove('on')
      clear()
      setStatus(`Restarting ${name}...`)
      try {
        const r = await api.request<{ error?: string; pids: string[]; stale: boolean }>('restart', { app: name })
        if (generation !== restartGeneration || r.stale) return // another restart meanwhile
        if (r.error) {
          setStatus(`Could not restart ${name}: ${r.error}`)
          return
        }
        setStatus(`Restarted ${name}` + (isAndroid() && r.pids.length === 0 ? ' (process id not found yet)' : ''))
        if (r.pids.length > 0 && app.value.trim() === name) {
          appPids = new Set(r.pids)
          filter = currentFilter()
          rebuild()
        }
      } catch (e) {
        setStatus(`Could not restart ${name}: ${(e as Error).message}`)
      }
    }

    async function save(): Promise<void> {
      const lines = view.slice()
      const r = await api.request<string>('save', { text: lines.map(String).join('\n'), count: lines.length }).catch((e: Error) => e.message)
      if (r) setStatus(r)
    }

    level.addEventListener('change', filterChanged)
    for (const f of [text, tag, app]) f.addEventListener('input', filterChanged)

    root.append(
      h('div', { class: 'mtb-row' }, 'Level:', level, text, tag, app, restart, regexToggle, pauseToggle, checkbox('Scroll to end', true, (v) => (autoScroll = v)), button('Clear', clear), button('Save...', save)),
      viewport,
      status,
    )

    const drainTimer = setInterval(drain, DRAIN_MS)
    void drainTimer

    api.on('started', () => {
      // A new stream replays the last lines of the device log: start from an empty list.
      clear()
    })
    api.on('state', (d) => setStatus((d as { text: string }).text))
    api.on('entries', (d) => receive(d as EntryDto[]))

    // From the Apps tab ("Show log of this app"): set the App filter.
    window.addEventListener('mtb:showLog', (ev) => {
      app.value = String((ev as CustomEvent<{ app: string }>).detail.app)
      filterChanged()
    })

    setStatus('Not started')
    renderRows()
  },
}
