// ported-from: ui/FilesPanel.kt
// Host half of the Files tab: owns the backend (adb / mobilecli fs), the local file system and the VS Code dialogs. The webview half only
// draws; every listing arrives already sorted and formatted. Pure logic is in core/files.
import { mkdtemp, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  EntryKind,
  FileEntry,
  FileFormat,
  FilePaths,
  FileSort,
  FilesException,
  SortKey,
  type FileBackend,
} from '../../core/files/files'
import { FilePreview, type Preview } from '../../core/files/preview'
import type { Device } from '../../core/model'
import type { ToolContext, ToolHost } from './toolHost'

const IOS_HOME = 'com.apple.springboard'
const APP_ID = /^[A-Za-z0-9._-]+$/

const supported = (d: Device): boolean => d.platform === 'ANDROID' || d.kind === 'SIMULATOR'

interface State {
  backend: FileBackend | undefined
  cwd: string
  entries: FileEntry[]
  sortKey: SortKey
  ascending: boolean
  warnedAboutAppWrites: boolean
  /** Bumped when the location changes: a connect that finishes late is dropped. */
  gen: number
}

// One ToolHost serves every open viewer, so the state is kept per device object (the viewer hands out a fresh ToolContext per call).
const states = new WeakMap<Device, State>()

function stateOf(ctx: ToolContext): State {
  let st = states.get(ctx.device)
  if (!st) {
    st = { backend: undefined, cwd: '', entries: [], sortKey: SortKey.NAME, ascending: true, warnedAboutAppWrites: false, gen: 0 }
    states.set(ctx.device, st)
  }
  return st
}

/** One row of the table as the webview draws it. */
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
  sortKey: SortKey
  ascending: boolean
}

function listing(st: State): ListingDto {
  const b = st.backend
  if (!b) throw new FilesException('Not connected')
  return {
    path: st.cwd,
    canUp: FilePaths.up(b.root, st.cwd) !== undefined,
    rows: st.entries.map((e) => ({
      name: e.name,
      path: e.path,
      isDir: e.isDir,
      isLink: e.isLink,
      type: FileFormat.typeLabel(e),
      size: e.isDir ? '' : FileFormat.size(e.size),
      modified: FileFormat.modified(e.modifiedMillis),
    })),
    root: b.root,
    isAppData: b.isAppData,
    appId: b.appId,
    canDownloadFolder: b.canDownloadFolder,
    sortKey: st.sortKey,
    ascending: st.ascending,
  }
}

function show(st: State, dir: string, entries: FileEntry[]): void {
  st.cwd = dir
  st.entries = FileSort.sort(entries, st.sortKey, st.ascending)
}

function backendOf(st: State): FileBackend {
  if (!st.backend) throw new FilesException('Not connected')
  return st.backend
}

function entryOf(st: State, p: string): FileEntry {
  const e = st.entries.find((x) => x.path === p)
  if (!e) throw new FilesException('That entry is no longer in the list; refresh the folder')
  return e
}

const confirm = async (message: string, action: string): Promise<boolean> => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action

/** First time per location: private app data changes can crash the app. */
async function appWriteWarning(st: State): Promise<boolean> {
  const b = backendOf(st)
  if (!b.isAppData || st.warnedAboutAppWrites) return true
  const ok = await confirm(`This changes the private data of ${b.appId}. The app may misbehave or crash if its files are changed. Continue?`, 'Continue')
  if (ok) st.warnedAboutAppWrites = true
  return ok
}

interface AppDto {
  id: string
  name: string
}

function parseApps(data: unknown): AppDto[] {
  if (!Array.isArray(data)) return []
  const out: AppDto[] = []
  for (const o of data) {
    if (typeof o !== 'object' || o === null) continue
    const r = o as Record<string, unknown>
    const id = typeof r.packageName === 'string' && r.packageName.trim() ? r.packageName : undefined
    if (id) out.push({ id, name: typeof r.appName === 'string' && r.appName.trim() ? r.appName : id })
  }
  return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const filesHost: ToolHost = {
  id: 'files',
  title: 'Files',

  async handle(method, params, ctx) {
    const st = stateOf(ctx)
    const p = (params ?? {}) as Record<string, unknown>
    const device = ctx.device
    switch (method) {
      case 'info':
        return {
          supported: supported(device),
          message: supported(device) ? '' : 'Files supports Android devices and iOS simulators, not physical iPhones',
          platform: device.platform,
          downloadFolder: ctx.settings().filesDownloadFolder,
        }

      case 'apps': {
        if (!supported(device)) return []
        try {
          return parseApps(await ctx.services.mobilecliData(device, ['apps', 'list'])).map((a) => a.id)
        } catch {
          return []
        }
      }

      case 'foreground': {
        const data = await ctx.services.mobilecliData(device, ['apps', 'foreground'])
        const id = data && typeof data === 'object' ? (data as Record<string, unknown>).packageName : undefined
        if (typeof id !== 'string' || !id.trim() || id === IOS_HOME) throw new FilesException('No app is in the foreground (home screen); type a package or bundle id')
        return { id }
      }

      case 'connect': {
        if (!supported(device)) throw new FilesException('Files supports Android devices and iOS simulators, not physical iPhones')
        const appId = typeof p.appId === 'string' && p.appId.trim() ? p.appId.trim() : undefined
        if (appId !== undefined && !APP_ID.test(appId)) throw new FilesException(`'${appId}' is not a package name or bundle id`)
        const my = ++st.gen
        st.backend = undefined
        st.entries = []
        st.cwd = ''
        st.warnedAboutAppWrites = false
        const backend = await ctx.services.files(device, appId)
        const entries = await backend.list(backend.home)
        if (my !== st.gen) throw new FilesException('Superseded by a newer request')
        st.backend = backend
        show(st, backend.home, entries)
        return listing(st)
      }

      case 'list': {
        const b = backendOf(st)
        const dir = FilePaths.normalize(String(p.path ?? st.cwd))
        const entries = await b.list(dir)
        show(st, dir, entries)
        return listing(st)
      }

      case 'sort': {
        backendOf(st)
        st.sortKey = (SortKey as Record<string, SortKey>)[String(p.key)] ?? SortKey.NAME
        st.ascending = p.ascending !== false
        st.entries = FileSort.sort(st.entries, st.sortKey, st.ascending)
        return listing(st)
      }

      /** Double click or Enter on a file: a link or (on iOS, where links look like files) any file is probed first. */
      case 'isFolder': {
        const b = backendOf(st)
        const e = entryOf(st, String(p.path))
        if (e.isDir) return true
        if (!e.isLink && device.platform === 'ANDROID') return false // a regular file: already previewed
        return (await b.kindOf(e.path)) === EntryKind.DIR
      }

      case 'preview': {
        const b = backendOf(st)
        const e = entryOf(st, String(p.path))
        // A database or a big file only needs its first bytes (the SQLite header) to be classified.
        const want = e.size > FilePreview.MAX_BYTES ? 16 : FilePreview.MAX_BYTES + 1
        const preview: Preview = FilePreview.build(e.name, await b.read(e.path, want), e.size)
        return { name: e.name, preview }
      }

      case 'download': {
        const b = backendOf(st)
        const e = entryOf(st, String(p.path))
        if (e.isDir && !b.canDownloadFolder) throw new FilesException("Folders of an app's data cannot be downloaded; download its files one by one")
        const remembered = ctx.settings().filesDownloadFolder
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: `Download ${e.name} to`,
          openLabel: 'Download here',
          defaultUri: remembered ? vscode.Uri.file(remembered) : undefined,
        })
        if (!picked?.length) return { cancelled: true }
        const folder = picked[0].fsPath
        await ctx.updateSetting('filesDownloadFolder', folder)
        const target = path.join(folder, e.name)
        if ((await stat(target).then(() => true, () => false)) && !(await confirm(`${target} exists. Replace it?`, 'Replace'))) return { cancelled: true }
        const local = await b.pull(e, folder)
        const bytes = await stat(local).then((s) => (s.isFile() ? s.size : undefined), () => undefined)
        const note = !e.isDir && bytes !== undefined && e.size > 0 && bytes !== e.size ? ` (the device listed ${FileFormat.size(e.size)})` : ''
        return { message: `Downloaded ${e.name}${bytes !== undefined ? ` (${FileFormat.size(bytes)})` : ''} to ${local}${note}` }
      }

      case 'upload': {
        const b = backendOf(st)
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: `Upload to ${st.cwd}`, openLabel: 'Upload' })
        if (!picked?.length) return { cancelled: true }
        const file = picked[0].fsPath
        if (!(await appWriteWarning(st))) return { cancelled: true }
        const name = path.basename(file)
        if (st.entries.some((e) => e.name === name) && !(await confirm(`${name} already exists in ${st.cwd}. Replace it?`, 'Replace'))) return { cancelled: true }
        const remote = await b.push(file, st.cwd)
        const size = (await stat(file)).size
        return { message: `Uploaded ${name} (${FileFormat.size(size)}) to ${remote}` }
      }

      case 'newFolder': {
        const b = backendOf(st)
        const name = (
          await vscode.window.showInputBox({ title: 'New Folder', prompt: `Folder name in ${st.cwd}`, validateInput: (v) => FilePaths.nameProblem(v) })
        )?.trim()
        if (!name) return { cancelled: true }
        if (!(await appWriteWarning(st))) return { cancelled: true }
        const target = FilePaths.join(st.cwd, name)
        await b.mkdir(target)
        return { message: `Created ${target}` }
      }

      case 'delete': {
        const b = backendOf(st)
        const e = entryOf(st, String(p.path))
        if (!(await appWriteWarning(st))) return { cancelled: true }
        const what = e.isDir ? `the folder ${e.name} and everything in it` : e.name
        if (!(await confirm(`Delete ${what} from the device? This cannot be undone.`, 'Delete'))) return { cancelled: true }
        await b.delete(e)
        return { message: `Deleted ${e.path}` }
      }

      /** A SQLite database has no viewer here: pull it with its journal files and show the folder in the file manager. */
      case 'pullDatabase': {
        const b = backendOf(st)
        const e = entryOf(st, String(p.path))
        const siblings = ['-wal', '-shm', '-journal'].flatMap((suffix) => st.entries.filter((x) => x.name === e.name + suffix))
        const dir = await mkdtemp(path.join(os.tmpdir(), 'mobiletestbench-db-'))
        let main: string
        try {
          main = await b.pull(e, dir)
          for (const s of siblings) await b.pull(s, dir)
        } catch (err) {
          await rm(dir, { recursive: true, force: true })
          throw err
        }
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(main))
        const extra = siblings.length ? ` with ${siblings.map((s) => s.name.slice(e.name.length)).join(', ')}` : ''
        return { message: `Pulled ${e.name}${extra} to ${path.dirname(main)} and showed it in the file manager` }
      }

      default:
        throw new Error(`Files: unknown method ${method}`)
    }
  },

  dispose(ctx) {
    const st = states.get(ctx.device)
    if (st) {
      st.gen++
      st.backend = undefined
    }
  },
}
