// ported-from: ui/FilesPanel.kt
// Webview half of the Files tab: location chooser, folder table, preview pane and the buttons. Everything that touches the device or the
// disk is a request to the host half (src/extension/tools/files.ts). `gen` (device or location changed), `listGen` and `previewGen` drop
// results that are no longer wanted, like in the Kotlin panel.
import type { Preview } from '../../core/files/preview'
import type { DeviceInfoDto } from '../../protocol'
import type { ToolApi, ToolView } from '../toolApi'
import { button, copyText, h, input, messageLine, select, table } from '../ui'

interface RowDto {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  type: string
  size: string
  modified: string
}
interface ListingDto {
  path: string
  canUp: boolean
  rows: RowDto[]
  root: string
  isAppData: boolean
  appId: string | undefined
  canDownloadFolder: boolean
  sortKey: string
  ascending: boolean
}
interface InfoDto {
  supported: boolean
  message: string
}
interface OpResult {
  cancelled?: boolean
  message?: string
}

const DEVICE_STORAGE = 'Device storage'
const APP_DATA = 'App data'
const COLUMNS = [
  { title: 'Name', key: 'NAME' },
  { title: 'Type', key: 'TYPE' },
  { title: 'Size', key: 'SIZE' },
  { title: 'Modified', key: 'MODIFIED' },
]

const CSS = `
  .mtb-files { display: flex; flex-direction: column; gap: 4px; height: 100%; }
  .mtb-files-main { display: flex; gap: 8px; flex: 1 1 auto; min-height: 120px; }
  .mtb-files-list { flex: 55 1 0; overflow: auto; min-width: 200px; }
  .mtb-files-preview { flex: 45 1 0; overflow: auto; min-width: 160px; display: flex; flex-direction: column; }
  .mtb-files-path { flex: 1 1 auto; min-width: 120px; }
  .mtb-files-app { width: 300px; }
  .mtb-files-list th { cursor: pointer; user-select: none; }
  .mtb-files-list td.num { text-align: right; white-space: nowrap; }
  .mtb-files-list tbody tr { cursor: default; }
  .mtb-files-title { font-weight: 600; padding: 2px 6px; }
  .mtb-files-body { overflow: auto; flex: 1 1 auto; }
`

export const filesView: ToolView = {
  id: 'files',
  title: 'Files',

  mount(root: HTMLElement, api: ToolApi) {
    if (!document.getElementById('mtb-files-styles')) {
      const style = h('style', { id: 'mtb-files-styles' })
      style.textContent = CSS
      document.head.append(style)
    }
    let device: DeviceInfoDto | undefined = api.device
    let visible = false
    let info: InfoDto | undefined
    let current: ListingDto | undefined
    let selected: string | undefined
    let busy = 0
    let appsLoaded = false
    let connecting = false
    let gen = 0
    let listGen = 0
    let previewGen = 0
    let sqlitePath: string | undefined

    const status = messageLine()
    const appStatus = h('span', { class: 'mtb-muted' }, ' ')
    const location = select([DEVICE_STORAGE, APP_DATA], DEVICE_STORAGE, () => {
      updateControls()
      void appsChanged()
    })
    const appInput = input('', { class: 'mtb-input mtb-files-app', list: 'mtb-files-apps', title: 'Package name or bundle id of the app (list from the device; Enter opens it)' })
    const appList = h('datalist', { id: 'mtb-files-apps' })
    appInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && location.value === APP_DATA) void appsChanged()
    })
    appInput.addEventListener('change', () => {
      if (location.value === APP_DATA) void appsChanged()
    })
    const foregroundBtn = button('Foreground app', () => useForegroundApp(true), { title: 'Use the app that is in front on the device' })
    const upBtn = button('Up', () => {
      if (current?.canUp) void navigate(parentOf(current.path, current.root))
    }, { title: 'Up' })
    const refreshBtn = button('Refresh', () => (current ? navigate(current.path) : connect()), { title: 'Refresh' })
    const pathInput = input('', { class: 'mtb-input mtb-files-path' })
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void navigate(normalize(pathInput.value.trim() || current?.path || '/'))
    })
    const copyBtn = button('Copy path', async () => {
      const text = selectedRow()?.path ?? current?.path ?? ''
      if (!text) return
      await copyText(text)
      status.set(`Copied ${text}`)
    })
    const listHost = h('div', { class: 'mtb-files-list' })
    const previewTitle = h('div', { class: 'mtb-files-title' }, ' ')
    const previewBody = h('div', { class: 'mtb-files-body' })
    const downloadBtn = button('Download', () => void download())
    const uploadBtn = button('Upload', () => void upload())
    const newFolderBtn = button('New folder', () => void newFolder())
    const deleteBtn = button('Delete', () => void remove())
    const progress = h('span', { class: 'mtb-muted' }, '')

    root.append(
      h(
        'div',
        { class: 'mtb-files' },
        h('div', { class: 'mtb-row' }, 'Location', location, 'App', appInput, appList, foregroundBtn, appStatus),
        h('div', { class: 'mtb-row' }, upBtn, refreshBtn, pathInput, copyBtn),
        h('div', { class: 'mtb-files-main' }, listHost, h('div', { class: 'mtb-files-preview' }, previewTitle, previewBody)),
        h('div', { class: 'mtb-row' }, downloadBtn, uploadBtn, newFolderBtn, deleteBtn, progress),
        status,
      ),
    )

    const selectedRow = (): RowDto | undefined => current?.rows.find((r) => r.path === selected)
    const appId = (): string | undefined => (location.value === APP_DATA ? appInput.value.trim() || undefined : undefined)
    const supported = () => !!device && !!info?.supported

    function normalize(path: string): string {
      const parts: string[] = []
      for (const p of path.split('/')) {
        if (p === '' || p === '.') continue
        if (p === '..') parts.pop()
        else parts.push(p)
      }
      return '/' + parts.join('/')
    }
    function parentOf(path: string, rootPath: string): string {
      const t = path.replace(/\/+$/, '')
      const i = t.lastIndexOf('/')
      const parent = i <= 0 ? '/' : t.substring(0, i)
      return parent.length < rootPath.length && rootPath !== '/' ? rootPath : parent
    }

    function setBusy(delta: number): void {
      busy += delta
      progress.textContent = busy > 0 ? 'Working...' : ''
      updateControls()
    }

    function updateControls(): void {
      const ok = supported()
      const e = selectedRow()
      location.disabled = !ok
      appInput.disabled = !(ok && location.value === APP_DATA)
      foregroundBtn.disabled = !ok
      upBtn.disabled = !current?.canUp
      refreshBtn.disabled = !ok
      pathInput.disabled = !current
      copyBtn.disabled = !current
      uploadBtn.disabled = !current || busy > 0
      newFolderBtn.disabled = !current || busy > 0
      deleteBtn.disabled = !current || !e || busy > 0
      downloadBtn.disabled = !current || !e || busy > 0 || (e.isDir && !current.canDownloadFolder)
      downloadBtn.title = current && e?.isDir && !current.canDownloadFolder ? "Folders of an app's data cannot be downloaded; download its files one by one" : ''
    }

    function showMessage(text: string, error = false, pull?: string): void {
      previewBody.replaceChildren(h('div', { class: error ? 'mtb-msg err' : 'mtb-msg', style: 'padding: 6px; white-space: pre-wrap' }, text))
      if (pull) previewBody.append(button('Pull and show in the file manager', () => pullDatabase(pull)))
    }

    function resetPreview(): void {
      previewTitle.textContent = ' '
      showMessage('Select a file to preview it.')
    }

    function renderList(): void {
      listHost.replaceChildren()
      if (!current) return
      const arrow = (key: string) => (current!.sortKey === key ? (current!.ascending ? '  ▲' : '  ▼') : '')
      const t = table(
        COLUMNS.map((c) => c.title + arrow(c.key)),
        current.rows.map((r) => [(r.isDir ? '📁 ' : r.isLink ? '🔗 ' : '📄 ') + r.name, r.type, r.size, r.modified]),
        (i, tr) => {
          const row = current!.rows[i]
          tr.dataset.path = row.path
          if (row.path === selected) tr.classList.add('sel')
          tr.addEventListener('click', () => select_(row.path))
          tr.addEventListener('dblclick', () => void open(row))
          tr.children[2]?.classList.add('num')
        },
      )
      const head = t.tHead!.rows[0]
      COLUMNS.forEach((c, i) => {
        head.cells[i].addEventListener('click', () => void sort(c.key))
      })
      listHost.append(t)
    }

    function select_(path: string | undefined): void {
      selected = path
      listHost.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('sel', (tr as HTMLElement).dataset.path === path))
      updateControls()
      void preview()
    }

    function applyListing(l: ListingDto, keepSelection: boolean): void {
      const keep = keepSelection ? selected : undefined
      current = l
      selected = keep && l.rows.some((r) => r.path === keep) ? keep : undefined
      pathInput.value = l.path
      renderList()
      if (!keepSelection || !selected) resetPreview()
      updateControls()
    }

    function reset(text: string): void {
      gen++
      listGen++
      previewGen++
      connecting = false
      current = undefined
      selected = undefined
      appsLoaded = false
      listHost.replaceChildren()
      pathInput.value = ''
      appStatus.textContent = ' '
      appList.replaceChildren()
      appInput.value = ''
      location.value = DEVICE_STORAGE
      resetPreview()
      updateControls()
      status.set(text)
    }

    // lifecycle

    async function activate(): Promise<void> {
      if (!device) return
      const my = gen
      if (!info) {
        try {
          info = await api.request<InfoDto>('info')
        } catch (e) {
          status.error(msg(e))
          return
        }
        if (my !== gen) return
        if (!info.supported) status.set(info.message)
        updateControls()
      }
      if (!supported()) return
      if (!appsLoaded) void loadApps()
      if (!current && !connecting) await connect()
    }

    async function loadApps(): Promise<void> {
      appsLoaded = true
      const my = gen
      const ids = await api.request<string[]>('apps').catch(() => [] as string[])
      if (my !== gen) return
      appList.replaceChildren(...ids.map((id) => h('option', { value: id })))
    }

    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] || 'Failed'

    async function appsChanged(): Promise<void> {
      if (!device) return
      if (location.value === APP_DATA && !appId()) {
        useForegroundApp(true)
        return
      }
      await connect()
    }

    function useForegroundApp(openAfter: boolean): void {
      if (!device) return
      const my = gen
      status.set('Reading the foreground app...')
      void api
        .request<{ id: string }>('foreground')
        .then(async (fg) => {
          if (my !== gen) return
          location.value = APP_DATA
          appInput.value = fg.id
          updateControls()
          if (openAfter) await connect()
          else status.set(`Foreground app: ${fg.id}`)
        })
        .catch((e) => {
          if (my === gen) status.error(msg(e))
        })
    }

    // browsing

    async function connect(): Promise<void> {
      if (!device || !supported()) return
      const id = appId()
      if (location.value === APP_DATA && !id) {
        status.error('Enter a package name or bundle id, or use Foreground app')
        return
      }
      const my = ++gen
      listGen++
      previewGen++
      current = undefined
      selected = undefined
      connecting = true
      listHost.replaceChildren()
      resetPreview()
      updateControls()
      status.set(`Opening ${id ?? 'device storage'}...`)
      setBusy(+1)
      try {
        const l = await api.request<ListingDto>('connect', { appId: id })
        if (my !== gen) return
        connecting = false
        applyListing(l, false)
        appStatus.textContent = id ? `Data of ${id}` : ' '
        status.set(`${l.rows.length} items`)
      } catch (e) {
        if (my !== gen) return
        connecting = false
        appStatus.textContent = ' '
        status.error(msg(e))
      } finally {
        setBusy(-1)
        if (my === gen) updateControls()
      }
    }

    async function navigate(path: string): Promise<void> {
      if (!current) return
      const my = gen
      const lg = ++listGen
      previewGen++
      status.set(`Loading ${path}...`)
      setBusy(+1)
      try {
        const l = await api.request<ListingDto>('list', { path })
        if (my !== gen || lg !== listGen) return
        applyListing(l, false)
        status.set(`${l.rows.length} items`)
      } catch (e) {
        if (my !== gen || lg !== listGen) return
        pathInput.value = current?.path ?? ''
        status.error(msg(e))
      } finally {
        setBusy(-1)
      }
    }

    async function sort(key: string): Promise<void> {
      if (!current) return
      const ascending = current.sortKey === key ? !current.ascending : true
      try {
        applyListing(await api.request<ListingDto>('sort', { key, ascending }), true)
      } catch (e) {
        status.error(msg(e))
      }
    }

    /** Double click: folders open; a link or (on iOS, where links look like files) any file is probed first. */
    async function open(row: RowDto): Promise<void> {
      if (row.isDir) {
        void navigate(row.path)
        return
      }
      if (!row.isLink && device?.platform === 'ANDROID') return // a regular file: already previewed
      const my = gen
      setBusy(+1)
      try {
        const isFolder = await api.request<boolean>('isFolder', { path: row.path })
        if (my === gen && isFolder) void navigate(row.path)
      } catch (e) {
        if (my === gen) status.error(msg(e) || `Could not open ${row.name}`)
      } finally {
        setBusy(-1)
      }
    }

    // preview

    async function preview(): Promise<void> {
      const e = selectedRow()
      const my = gen
      const pg = ++previewGen
      if (!e || !current) {
        resetPreview()
        return
      }
      previewTitle.textContent = e.name
      if (e.isDir) {
        showMessage('Folder. Double click to open it.')
        return
      }
      showMessage('Loading...')
      try {
        const r = await api.request<{ name: string; preview: Preview }>('preview', { path: e.path })
        if (my !== gen || pg !== previewGen) return
        render(r.name, e.path, r.preview)
      } catch (err) {
        if (my === gen && pg === previewGen) showMessage(msg(err), true)
      }
    }

    function render(name: string, path: string, p: Preview): void {
      switch (p.kind) {
        case 'Text':
          previewTitle.textContent = `${name} (${p.format})`
          previewBody.replaceChildren(h('pre', { class: 'mtb-code' }, p.text))
          break
        case 'Table':
          previewTitle.textContent = p.title
          previewBody.replaceChildren(table(p.columns, p.rows))
          break
        case 'Message':
          showMessage(p.text)
          break
        case 'Sqlite':
          sqlitePath = path
          showMessage(`${p.text} Pull it with its -wal and -shm files and open it in a database tool.`, false, path)
          break
      }
    }

    // actions

    /** Runs [work], shows its message (or the error) and optionally reloads the folder keeping that message. */
    async function runOp(label: string, work: () => Promise<OpResult>, refreshAfter = false): Promise<void> {
      const my = gen
      status.set(`${label}...`)
      setBusy(+1)
      let message: string | undefined
      let error = false
      try {
        const r = await work()
        if (my !== gen) return
        if (r.cancelled) {
          status.set(' ')
          return
        }
        message = r.message ?? ''
        status.set(message)
      } catch (e) {
        if (my !== gen) return
        message = msg(e)
        error = true
        status.error(message)
      } finally {
        setBusy(-1)
      }
      if (refreshAfter && current && my === gen) {
        const lg = ++listGen
        const path = current.path
        try {
          const l = await api.request<ListingDto>('list', { path })
          if (my !== gen || lg !== listGen) return
          applyListing(l, true)
          if (error) status.error(message ?? '')
          else status.set(message ?? '')
        } catch (e) {
          if (my === gen && lg === listGen) status.error(`${message} (reload failed: ${msg(e)})`)
        }
      }
    }

    async function download(): Promise<void> {
      const e = selectedRow()
      if (e) await runOp(`Downloading ${e.name}`, () => api.request<OpResult>('download', { path: e.path }))
    }
    async function upload(): Promise<void> {
      await runOp('Uploading', () => api.request<OpResult>('upload'), true)
    }
    async function newFolder(): Promise<void> {
      await runOp('Creating folder', () => api.request<OpResult>('newFolder'), true)
    }
    async function remove(): Promise<void> {
      const e = selectedRow()
      if (e) await runOp(`Deleting ${e.name}`, () => api.request<OpResult>('delete', { path: e.path }), true)
    }
    async function pullDatabase(path: string): Promise<void> {
      await runOp('Pulling the database', () => api.request<OpResult>('pullDatabase', { path: path || sqlitePath }))
    }

    resetPreview()
    updateControls()
    status.set(device ? ' ' : 'Not connected')

    // The tool host calls these through the ToolView object below; keep the closure reachable.
    activateHook = () => {
      visible = true
      void activate()
    }
    hiddenHook = () => {
      visible = false
    }
    deviceHook = (d) => {
      device = d
      info = undefined
      reset(d ? ' ' : 'Not connected')
      if (visible) void activate()
    }
    if (shownBeforeMount) activateHook()
  },

  deviceChanged(d) {
    deviceHook(d)
  },
  shown() {
    activateHook()
  },
  hidden() {
    hiddenHook()
  },
}

// ToolView callbacks reach the state of the mounted tab through these (one mounted tab per webview).
let shownBeforeMount = false
let activateHook: () => void = () => {
  shownBeforeMount = true
}
let hiddenHook: () => void = () => {}
let deviceHook: (d: DeviceInfoDto | undefined) => void = () => {}
