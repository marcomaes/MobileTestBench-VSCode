// ported-from: core/files/Files.kt
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { once } from 'node:events'
import type { CommandResult, CommandRunner } from '../exec/commandRunner'
import { MobilecliException, MobilecliJson } from '../mobilecliJson'

/** A failure of a file operation; the message is meant to be shown as is. */
export class FilesException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilesException'
  }
}

/** One entry of a directory listing. [modifiedMillis] is epoch milliseconds, undefined when unknown. */
export interface FileEntry {
  readonly name: string
  readonly path: string
  readonly isDir: boolean
  readonly size: number
  readonly modifiedMillis?: number
  /** True for a symbolic link (Android only: iOS listings cannot tell a link from a file). A link is never a [isDir]; probe it with [FileBackend.kindOf]. */
  readonly isLink: boolean
}

export const FileEntry = (name: string, path: string, isDir: boolean, size: number, modifiedMillis?: number, isLink = false): FileEntry => ({
  name,
  path,
  isDir,
  size,
  modifiedMillis,
  isLink,
})

export const EntryKind = { DIR: 'DIR', FILE: 'FILE' } as const
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind]

const trimEndSlashes = (s: string): string => s.replace(/\/+$/, '')

/** Pure path helpers. Remote paths always use '/' and are absolute (mobilecli would read a leading '-' as a flag). */
export const FilePaths = {
  join: (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`),

  name(path: string): string {
    const t = trimEndSlashes(path)
    return t.slice(t.lastIndexOf('/') + 1)
  },

  parent(path: string): string {
    const t = trimEndSlashes(path)
    const i = t.lastIndexOf('/')
    return i <= 0 ? '/' : t.substring(0, i)
  },

  /** Collapses `//`, `.` and `..` (never above "/"), drops a trailing slash. Relative input stays relative to "/". */
  normalize(path: string): string {
    const parts: string[] = []
    for (const p of path.split('/')) {
      if (p === '' || p === '.') continue
      if (p === '..') parts.pop()
      else parts.push(p)
    }
    return '/' + parts.join('/')
  },

  isInside(root: string, path: string): boolean {
    const r = FilePaths.normalize(root)
    const p = FilePaths.normalize(path)
    return r === '/' || p === r || p.startsWith(`${r}/`)
  },

  /** The parent of [path] for the Up button, or undefined when [path] already is [root]. */
  up(root: string, path: string): string | undefined {
    const p = FilePaths.normalize(path)
    if (p === FilePaths.normalize(root)) return undefined
    const parent = FilePaths.parent(p)
    return FilePaths.isInside(root, parent) ? parent : undefined
  },

  /** Single quotes for the remote sh: `it's` becomes `'it'\''s'`. */
  shellQuote: (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'",

  /** A reason the name is not valid for a new folder, or undefined when it is fine. */
  nameProblem(name: string): string | undefined {
    if (name.trim() === '') return 'Enter a name'
    if (name === '.' || name === '..') return `'${name}' is not a valid name`
    if (name.includes('/')) return "A name cannot contain '/'"
    if (/[\n\r\u0000]/.test(name)) return 'A name cannot contain line breaks'
    return undefined
  },
}

const pad2 = (n: string) => n.padStart(2, '0')

/** Sizes and dates as shown in the table. */
export const FileFormat = {
  size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
    return `${(bytes / 1073741824).toFixed(2)} GB`
  },

  /** `yyyy-MM-dd HH:mm` in [zone] (an IANA name, default the system zone). */
  modified(millis: number | undefined, zone?: string): string {
    if (millis === undefined) return ''
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(millis))
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${pad2(get('month'))}-${pad2(get('day'))} ${pad2(get('hour'))}:${pad2(get('minute'))}`
  },

  typeLabel(e: FileEntry): string {
    if (e.isDir) return 'Folder'
    if (e.isLink) return 'Link'
    return 'File'
  },
}

export const SortKey = { NAME: 'NAME', TYPE: 'TYPE', SIZE: 'SIZE', MODIFIED: 'MODIFIED' } as const
export type SortKey = (typeof SortKey)[keyof typeof SortKey]

const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0)

export const FileSort = {
  /** Folders (and links) first, then by [key]; ties by name. Descending reverses within the folder and file groups. */
  sort(entries: readonly FileEntry[], key: SortKey = SortKey.NAME, ascending = true): FileEntry[] {
    const byName = (a: FileEntry, b: FileEntry) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.name, b.name)
    let main: (a: FileEntry, b: FileEntry) => number
    switch (key) {
      case SortKey.NAME:
        main = byName
        break
      case SortKey.TYPE:
        main = (a, b) => cmp(FileFormat.typeLabel(a), FileFormat.typeLabel(b)) || byName(a, b)
        break
      case SortKey.SIZE:
        main = (a, b) => cmp(a.isDir ? -1 : a.size, b.isDir ? -1 : b.size) || byName(a, b)
        break
      case SortKey.MODIFIED:
        main = (a, b) => cmp(a.modifiedMillis ?? -Infinity, b.modifiedMillis ?? -Infinity) || byName(a, b)
        break
    }
    const ordered = ascending ? main : (a: FileEntry, b: FileEntry) => main(b, a)
    return [...entries].sort((a, b) => cmp(a.isDir ? 0 : 1, b.isDir ? 0 : 1) || ordered(a, b))
  },
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asLong = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v)
  return undefined
}
const strictLong = (s: string): number | undefined => (/^-?\d+$/.test(s) ? Number(s) : undefined)

/** Parsers for the two listing formats. */
export const FileParsers = {
  /** `mobilecli fs ls` stdout (the `{"status":"ok","data":[...]}` envelope). Throws [MobilecliException] on an error envelope. */
  parseMobilecliLs(stdout: string): FileEntry[] {
    const data = MobilecliJson.data(stdout)
    if (!Array.isArray(data)) return []
    const out: FileEntry[] = []
    for (const e of data) {
      if (!isObject(e)) continue
      const path = typeof e.path === 'string' ? e.path : undefined
      if (path === undefined) continue
      const name = typeof e.name === 'string' ? e.name : FilePaths.name(path)
      const isDir = typeof e.isDir === 'boolean' ? e.isDir : e.isDir === 'true'
      const size = isDir ? 0 : (asLong(e.size) ?? 0)
      let time: number | undefined
      if (typeof e.modTime === 'string') {
        const t = Date.parse(e.modTime)
        time = Number.isNaN(t) ? undefined : t
      }
      out.push(FileEntry(name, path, isDir, size, time))
    }
    return out
  },

  /** The common start folder of an iOS simulator device listing: the parent of the entry paths. Undefined for an empty listing. */
  parentOfEntries: (entries: readonly FileEntry[]): string | undefined => (entries.length ? FilePaths.parent(entries[0].path) : undefined),

  /**
   * Lines `%F|%s|%Y|%n` of `stat -c`, as printed by `find ... -exec stat`. [dir] is the listed directory; the entry name is the part of
   * `%n` after the last '/' (`./name` inside an app, a full path on device storage). Lines that do not parse (warnings) are skipped.
   */
  parseStatLines(output: string, dir: string): FileEntry[] {
    const out: FileEntry[] = []
    for (const raw of output.split(/\r\n|\n|\r/)) {
      const line = raw.replace(/\r+$/, '')
      const all = line.split('|')
      if (all.length < 4) continue
      const parts = [all[0], all[1], all[2], all.slice(3).join('|')] // split('|', limit = 4)
      const size = strictLong(parts[1])
      if (size === undefined) continue
      const seconds = strictLong(parts[2])
      if (seconds === undefined) continue
      const trimmed = trimEndSlashes(parts[3])
      const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
      if (name === '') continue
      const type = parts[0]
      const isDir = type === 'directory'
      out.push(FileEntry(name, FilePaths.join(dir, name), isDir, isDir ? 0 : size, seconds * 1000, type === 'symbolic link'))
    }
    return out
  },
}

/** Turns tool output into a readable message. */
export const FileErrors = {
  /** The first useful text of a failed command: stderr, else stdout (run-as prints its errors there). */
  message(result: CommandResult, fallback: string): string {
    const text = [result.stderr.trim(), result.text.trim()].find((s) => s.length > 0)
    return text === undefined ? fallback : text.split(/\r\n|\n|\r/).slice(0, 3).join(' ').slice(0, 300)
  },

  /** Adds the way out for a non debuggable Android app. */
  appDataHint(message: string, packageName: string | undefined): string {
    return packageName !== undefined && (message.includes('not debuggable') || message.includes('unknown package'))
      ? `${message}. Only debuggable apps allow this; try Device storage and /sdcard/Android/data/${packageName}`
      : message
  },
}

/** What the Files tab needs from a device. Failures are [FilesException]s. */
export interface FileBackend {
  /** Navigation never goes above this folder. */
  readonly root: string
  /** Where the tab starts (inside [root]). */
  readonly home: string
  readonly isAppData: boolean
  /** The android package or iOS bundle id of an app container, undefined for device storage. */
  readonly appId: string | undefined
  /** Whether Download can fetch a whole folder. */
  readonly canDownloadFolder: boolean

  list(path: string): Promise<FileEntry[]>
  /** Whether [path] (a symbolic link, or any non folder entry) is a folder or a file. */
  kindOf(path: string): Promise<EntryKind>
  /** At most [maxBytes] bytes from the start of the file. */
  read(path: string, maxBytes: number): Promise<Buffer>
  /** Copies [remote] into [localFolder] under its own name and returns the local file. A folder only when [canDownloadFolder]. */
  pull(remote: FileEntry, localFolder: string): Promise<string>
  /** Copies [local] into the remote folder [remoteDir] under its own name and returns that remote path. */
  push(local: string, remoteDir: string): Promise<string>
  mkdir(path: string): Promise<void>
  delete(entry: FileEntry): Promise<void>
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/** Reads at most the first 4096 bytes of a stream as text and discards the rest. */
function headText(stream: NodeJS.ReadableStream | null): { text(): string } {
  const chunks: Buffer[] = []
  let have = 0
  stream?.on('data', (c: Buffer) => {
    if (have < 4096) {
      const part = c.subarray(0, 4096 - have)
      chunks.push(part)
      have += part.length
    }
  })
  return { text: () => Buffer.concat(chunks).toString('utf8') }
}

/**
 * Runs a command that streams a file through stdin or stdout. Returns the exit code and the text it printed apart from the streamed file.
 * Needs a runner whose `start` honours the `stdin` argument ('pipe') when [stdinFile] is given.
 */
export async function runStreaming(runner: CommandRunner, command: string[], stdinFile: string | undefined, stdoutFile: string | undefined, timeoutMs: number): Promise<[number, string]> {
  const child = runner.start(command, stdinFile ? 'pipe' : 'ignore')
  const err = headText(child.stderr)
  const out = stdoutFile ? undefined : headText(child.stdout)
  const pending: Promise<unknown>[] = []
  if (stdoutFile && child.stdout) {
    const ws = createWriteStream(stdoutFile)
    child.stdout.pipe(ws)
    pending.push(once(ws, 'finish').catch(() => undefined))
  } else child.stdout?.resume()
  child.stderr?.resume()
  if (stdinFile && child.stdin) {
    const stdin = child.stdin
    stdin.on('error', () => undefined) // EPIPE: the process ended before reading everything
    createReadStream(stdinFile).on('error', () => stdin.end()).pipe(stdin)
  }
  let startError: Error | undefined
  const closed = new Promise<number>((resolve) => {
    child.on('error', (e) => {
      startError = e
      resolve(-1)
    })
    child.on('close', (code, signal) => resolve(code ?? (signal === 'SIGKILL' ? 137 : 143)))
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const code = await Promise.race([closed, timeout])
  clearTimeout(timer)
  if (code === 'timeout') {
    child.kill('SIGKILL')
    throw new FilesException(`Timed out after ${Math.trunc(timeoutMs / 1000 / 60)} min`)
  }
  if (startError) throw new FilesException(`Cannot start ${command[0]}: ${startError.message}`)
  // Let the file writer finish (the stream ended with the process), but never wait for ever.
  await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 5000))])
  const text = [err.text(), out?.text() ?? ''].map((s) => s.trim()).join('\n').trim()
  return [code, text]
}

const PACKAGE_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Android files over adb only. mobilecli is not used here: its `fs pull` reports success for a missing file and writes the shell's error
 * text into the local file, and its other errors lose the reason. [packageName] set means the app's private data through `run-as` (debuggable
 * apps only); paths stay absolute (`/data/user/0/<pkg>/...`) in the UI and are made relative to the app's data folder for `run-as`.
 */
export class AndroidFiles implements FileBackend {
  readonly root: string
  readonly home: string

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
    private readonly packageName?: string,
  ) {
    // The id ends up in the device shell (`run-as <id>`): only package name characters get that far.
    if (packageName !== undefined && !PACKAGE_NAME.test(packageName)) throw new FilesException(`'${packageName}' is not a package name`)
    this.root = packageName === undefined ? '/' : `/data/user/0/${packageName}`
    this.home = packageName === undefined ? '/sdcard' : this.root
  }

  get isAppData(): boolean {
    return this.packageName !== undefined
  }
  get appId(): string | undefined {
    return this.packageName
  }
  get canDownloadFolder(): boolean {
    return this.packageName === undefined
  }

  private shellCommand(script: string): string[] {
    return [this.adb, '-s', this.serial, 'shell', this.packageName === undefined ? script : `run-as ${this.packageName} sh -c ${FilePaths.shellQuote(script)}`]
  }

  /** The path as the shell sees it: unchanged on device storage, relative to the data folder in an app. */
  target(path: string): string {
    const p = FilePaths.normalize(path)
    if (this.packageName === undefined) return p
    if (!FilePaths.isInside(this.root, p)) throw new FilesException(`${p} is outside the app's data folder`)
    return p === this.root ? '.' : p.slice(this.root.length + 1)
  }

  private q(path: string): string {
    return FilePaths.shellQuote(this.target(path))
  }

  private sh(script: string, timeoutMs = 30_000): Promise<CommandResult> {
    return this.runner.run(this.shellCommand(script), timeoutMs)
  }

  private fail(result: CommandResult, what: string): never {
    throw new FilesException(FileErrors.appDataHint(FileErrors.message(result, `${what} failed (exit ${result.exitCode})`), this.packageName))
  }

  async list(path: string): Promise<FileEntry[]> {
    const dir = FilePaths.normalize(path)
    const result = await this.sh(`find ${FilePaths.shellQuote(trimEndSlashes(this.target(dir)) + '/')} -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} +`)
    const entries = FileParsers.parseStatLines(result.text, dir)
    // find exits 1 when only some entries were unreadable; a failure with nothing parsed is the real error (also run-as's own message).
    if (!result.ok && entries.length === 0) this.fail(result, 'Listing')
    return entries
  }

  async kindOf(path: string): Promise<EntryKind> {
    const result = await this.sh(`stat -L -c %F ${this.q(path)}`)
    if (!result.ok) this.fail(result, 'Reading')
    return result.text.trim() === 'directory' ? EntryKind.DIR : EntryKind.FILE
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const result = await this.sh(`head -c ${maxBytes} ${this.q(path)}`)
    if (!result.ok) this.fail(result, 'Reading')
    return result.stdout
  }

  async pull(remote: FileEntry, localFolder: string): Promise<string> {
    const local = join(localFolder, remote.name)
    const existedBefore = await exists(local)
    if (this.packageName === undefined) {
      // adb pull exits 1 with a clear message; a folder is pulled recursively into <localFolder>/<name>.
      const result = await this.runner.run([this.adb, '-s', this.serial, 'pull', remote.path, remote.isDir ? localFolder : local], 10 * 60_000)
      if (!result.ok) {
        // Only drop a file this call may have created; a file the user confirmed to overwrite stays when adb wrote nothing.
        if (!remote.isDir && !existedBefore) await rm(local, { force: true })
        this.fail(result, 'Download')
      }
    } else {
      if (remote.isDir) throw new FilesException("Downloading a folder of an app's data is not supported; download its files one by one")
      // Stream into a temporary file next to the target and move it over only on success: a failure or timeout leaves no partial file
      // and keeps an existing file the user confirmed to overwrite.
      const part = join(localFolder, `.${remote.name}.mobiletestbench-part`)
      try {
        const [code, text] = await runStreaming(this.runner, this.shellCommand(`cat ${this.q(remote.path)}`), undefined, part, 10 * 60_000)
        if (code !== 0) {
          // run-as prints its own errors on stdout, which went into the file: read them back.
          let message = text
          if (!message.trim()) message = await readFile(part).then((b) => b.subarray(0, 300).toString('utf8').trim(), () => '')
          throw new FilesException(FileErrors.appDataHint(message.trim() ? message : `Download failed (exit ${code})`, this.packageName))
        }
        await rename(part, local)
      } finally {
        await rm(part, { force: true })
      }
    }
    return local
  }

  async push(local: string, remoteDir: string): Promise<string> {
    const remote = FilePaths.join(FilePaths.normalize(remoteDir), basename(local))
    if (this.packageName === undefined) {
      const result = await this.runner.run([this.adb, '-s', this.serial, 'push', local, remote], 10 * 60_000)
      if (!result.ok) this.fail(result, 'Upload')
    } else {
      const [code, text] = await runStreaming(this.runner, this.shellCommand(`cat > ${this.q(remote)}`), local, undefined, 10 * 60_000)
      if (code !== 0) throw new FilesException(FileErrors.appDataHint(text.trim() ? text : `Upload failed (exit ${code})`, this.packageName))
    }
    return remote
  }

  async mkdir(path: string): Promise<void> {
    const result = await this.sh(`mkdir ${this.q(path)}`)
    if (!result.ok) this.fail(result, 'New folder')
  }

  async delete(entry: FileEntry): Promise<void> {
    const result = await this.sh(`rm ${entry.isDir ? '-r ' : ''}${this.q(entry.path)}`)
    if (!result.ok) this.fail(result, 'Delete')
  }
}

/**
 * iOS simulator files through `mobilecli fs`, with absolute host paths below [root] (the simulator's data folder, or an app's data container:
 * mobilecli's pull and push take no bundle id). [call] runs `mobilecli <args>` for the device and returns stdout, throwing with mobilecli's own text.
 * A simulator's files are plain host files, so previews and folder downloads read them directly.
 */
export class IosFiles implements FileBackend {
  constructor(
    private readonly call: (args: string[]) => Promise<string>,
    readonly root: string,
    readonly appId: string | undefined = undefined,
  ) {}

  get home(): string {
    return this.root
  }
  get isAppData(): boolean {
    return this.appId !== undefined
  }
  get canDownloadFolder(): boolean {
    return true
  }

  private shorten(text: string): string {
    return text.split(this.root).join('<root>')
  }

  private guard(path: string): string {
    const p = FilePaths.normalize(path)
    if (!FilePaths.isInside(this.root, p)) throw new FilesException(`${p} is outside the simulator's ${this.appId !== undefined ? 'app container' : 'data folder'}`)
    return p
  }

  private async run(args: string[]): Promise<string> {
    try {
      return await this.call(args)
    } catch (e) {
      if (e instanceof FilesException) throw e
      throw new FilesException(this.shorten(e instanceof Error ? e.message || e.name : String(e)))
    }
  }

  async list(path: string): Promise<FileEntry[]> {
    try {
      return FileParsers.parseMobilecliLs(await this.run(['fs', 'ls', this.guard(path)]))
    } catch (e) {
      if (e instanceof MobilecliException) throw new FilesException(this.shorten(e.message))
      throw e
    }
  }

  async kindOf(path: string): Promise<EntryKind> {
    const p = this.guard(path)
    const entries = await this.list(p)
    return entries.length === 1 && FilePaths.normalize(entries[0].path) === p ? EntryKind.FILE : EntryKind.DIR
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const file = this.guard(path)
    const name = basename(file)
    const s = await stat(file).catch(() => undefined)
    if (s?.isDirectory()) throw new FilesException(`${name} is a folder`)
    if (!s?.isFile()) throw new FilesException(`${name} cannot be read`)
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, s.size))
      let at = 0
      while (at < buffer.length) {
        const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at)
        if (bytesRead === 0) break
        at += bytesRead
      }
      return buffer.subarray(0, at)
    } finally {
      await handle.close()
    }
  }

  async pull(remote: FileEntry, localFolder: string): Promise<string> {
    const p = this.guard(remote.path)
    const local = join(localFolder, remote.name)
    if (remote.isDir) {
      try {
        await cp(p, local, { recursive: true, force: true })
      } catch {
        throw new FilesException(`Copying ${remote.name} failed`)
      }
    } else {
      await this.run(['fs', 'pull', p, local])
    }
    return local
  }

  async push(local: string, remoteDir: string): Promise<string> {
    // iOS refuses a push to an existing directory: always push to the full file path.
    const remote = FilePaths.join(this.guard(remoteDir), basename(local))
    await this.run(['fs', 'push', local, remote])
    return remote
  }

  async mkdir(path: string): Promise<void> {
    await this.run(['fs', 'mkdir', this.guard(path)])
  }

  async delete(entry: FileEntry): Promise<void> {
    await this.run(entry.isDir ? ['fs', 'rm', '-r', this.guard(entry.path)] : ['fs', 'rm', this.guard(entry.path)])
  }

  /** The simulator's data folder from `fs ls` without a path (the parent of the entries). */
  static async deviceRoot(call: (args: string[]) => Promise<string>): Promise<string> {
    const parent = FileParsers.parentOfEntries(FileParsers.parseMobilecliLs(await call(['fs', 'ls'])))
    if (parent === undefined) throw new FilesException("Could not find the simulator's data folder")
    return FilePaths.normalize(parent)
  }

  /** The app data container from `simctl get_app_container <udid> <bundle> data` output; undefined when there is none (system apps print `(null)`). */
  static parseContainer(result: CommandResult): string | undefined {
    if (!result.ok) return undefined
    const t = result.text.trim()
    return t !== '' && t !== '(null)' && t.startsWith('/') ? FilePaths.normalize(t) : undefined
  }

  static async appContainer(runner: CommandRunner, xcrun: string, udid: string, bundleId: string): Promise<string> {
    const result = await runner.run([xcrun, 'simctl', 'get_app_container', udid, bundleId, 'data'])
    const container = IosFiles.parseContainer(result)
    if (container !== undefined) return container
    throw new FilesException(
      result.ok
        ? `${bundleId} has no data container on this simulator (system apps have none)`
        : `No data container for ${bundleId}: ` + FileErrors.message(result, 'app not installed'),
    )
  }
}
