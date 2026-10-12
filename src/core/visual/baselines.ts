// ported-from: core/visual/Baselines.kt
import { access, mkdir, readdir, readFile, rename as fsRename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { rect, type Rect, type Size } from '../model'
import { encodePng, type PixelReader } from '../image/pixels'

/** The `<name>.json` next to a baseline PNG. Sizes are the logical size of the device and the pixel size of the saved frame. */
export class BaselineInfo {
  readonly device: string
  readonly logicalWidth: number
  readonly logicalHeight: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** Epoch milliseconds. */
  readonly savedAt: number
  /** Areas skipped by the comparison (status bar clock, ads...), in logical coordinates as [x, y, width, height]. */
  readonly ignore: number[][]

  constructor(o: Partial<{ device: string; logicalWidth: number; logicalHeight: number; frameWidth: number; frameHeight: number; savedAt: number; ignore: number[][] }> = {}) {
    this.device = o.device ?? ''
    this.logicalWidth = o.logicalWidth ?? 0
    this.logicalHeight = o.logicalHeight ?? 0
    this.frameWidth = o.frameWidth ?? 0
    this.frameHeight = o.frameHeight ?? 0
    this.savedAt = o.savedAt ?? 0
    this.ignore = o.ignore ?? []
  }

  get logicalSize(): Size {
    return { width: this.logicalWidth, height: this.logicalHeight }
  }
  get frameSize(): Size {
    return { width: this.frameWidth, height: this.frameHeight }
  }
  get ignoreRects(): Rect[] {
    return this.ignore.filter((r) => r.length === 4).map((r) => rect(r[0], r[1], r[2], r[3]))
  }
  withIgnore(rects: Rect[]): BaselineInfo {
    return new BaselineInfo({ ...this, ignore: rects.map((r) => [r.x, r.y, r.width, r.height]) })
  }
}

/** A baseline found on disk. [png] is the path of the image. */
export interface Baseline {
  readonly name: string
  readonly png: string
  readonly info: BaselineInfo
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Pure naming rules for baseline files. */
export const BaselineNames = {
  /** A file name part: letters, digits, dot, dash and underscore stay, the rest becomes `_`; never empty, no leading dot. */
  sanitize(raw: string): string {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
    return (cleaned || 'baseline').slice(0, 80)
  },

  /** Default name for a new baseline: the foreground app when known, else just the date. */
  defaultName(app: string | undefined | null, now: Date = new Date()): string {
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    return !app || !app.trim() ? `screen-${stamp}` : `${BaselineNames.sanitize(app)}-${stamp}`
  },

  /**
   * Why [raw] cannot be the new name of the baseline [current], or undefined when it can. Names compare after [sanitize]
   * and ignoring case (a case-insensitive file system treats "A" and "a" as one file), so a case-only change of the
   * baseline itself is allowed.
   */
  renameError(raw: string, current: string, existing: Iterable<string>): string | undefined {
    if (!raw.trim()) return 'Enter a name'
    const target = BaselineNames.sanitize(raw)
    if (target === current) return 'That is already the name'
    for (const e of existing) if (e !== current && e.toLowerCase() === target.toLowerCase()) return `A baseline named "${target}" already exists`
    return undefined
  },

  /** Parses "x, y, w, h" (commas or spaces); undefined unless four integers with a positive size and a non negative origin. */
  parseRect(text: string): Rect | undefined {
    const parts = text.split(/[,\s]+/).filter((s) => s.length > 0)
    if (parts.some((p) => !/^[+-]?\d+$/.test(p))) return undefined
    const n = parts.map(Number)
    if (n.length !== 4 || n[0] < 0 || n[1] < 0 || n[2] <= 0 || n[3] <= 0) return undefined
    return rect(n[0], n[1], n[2], n[3])
  },
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)
const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false)
const withoutExtension = (file: string): string => {
  const b = basename(file)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
}

/** Baselines on disk: `<root>/<device name>/<name>.png` plus `<name>.json`. */
export class BaselineStore {
  constructor(private readonly root: string) {}

  folder(deviceName: string): string {
    return join(this.root, BaselineNames.sanitize(deviceName))
  }

  private png(deviceName: string, name: string): string {
    return join(this.folder(deviceName), BaselineNames.sanitize(name) + '.png')
  }

  private json(png: string): string {
    return join(dirname(png), withoutExtension(png) + '.json')
  }

  /** Writes the frame; saving over an existing name replaces the image and keeps its ignore regions. */
  async save(deviceName: string, name: string, frame: PixelReader, logical: Size | undefined, now: number = Date.now()): Promise<Baseline> {
    const file = this.png(deviceName, name)
    await mkdir(dirname(file), { recursive: true })
    const kept = (await this.readInfo(this.json(file)))?.ignore ?? []
    await writeFile(file, encodePng(frame))
    const l = logical ?? { width: frame.width, height: frame.height }
    const info = new BaselineInfo({ device: deviceName, logicalWidth: l.width, logicalHeight: l.height, frameWidth: frame.width, frameHeight: frame.height, savedAt: now, ignore: kept })
    await this.writeInfo(file, info)
    return { name: withoutExtension(file), png: file, info }
  }

  /** Writes [frame] over the image of [baseline] itself (whatever its file name) and keeps its ignore regions. */
  async replaceImage(baseline: Baseline, frame: PixelReader, logical: Size | undefined, now: number = Date.now()): Promise<Baseline> {
    const kept = (await this.readInfo(this.json(baseline.png)))?.ignore ?? []
    await writeFile(baseline.png, encodePng(frame))
    const l = logical ?? { width: frame.width, height: frame.height }
    const info = new BaselineInfo({ device: baseline.info.device, logicalWidth: l.width, logicalHeight: l.height, frameWidth: frame.width, frameHeight: frame.height, savedAt: now, ignore: kept })
    await this.writeInfo(baseline.png, info)
    return { name: withoutExtension(baseline.png), png: baseline.png, info }
  }

  async list(deviceName: string): Promise<Baseline[]> {
    const dir = this.folder(deviceName)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out: Baseline[] = []
    for (const n of names) {
      const file = join(dir, n)
      if (!n.endsWith('.png') || !(await isFile(file))) continue
      out.push({ name: withoutExtension(file), png: file, info: (await this.readInfo(this.json(file))) ?? new BaselineInfo({ device: deviceName }) })
    }
    return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
  }

  /** The PNG bytes of the baseline; decode them with `decodeImage`. */
  async load(baseline: Baseline): Promise<Buffer> {
    try {
      return await readFile(baseline.png)
    } catch {
      throw new Error(`${basename(baseline.png)} is not a readable PNG`)
    }
  }

  async updateIgnore(baseline: Baseline, rects: Rect[]): Promise<Baseline> {
    const info = baseline.info.withIgnore(rects)
    await this.writeInfo(baseline.png, info)
    return { ...baseline, info }
  }

  /** Renames the image and its sidecar; the ignore regions go with it. Throws when the new name is taken. */
  async rename(baseline: Baseline, newName: string): Promise<Baseline> {
    const target = join(dirname(baseline.png), BaselineNames.sanitize(newName) + '.png')
    const sameFile = basename(target).toLowerCase() === basename(baseline.png).toLowerCase()
    const taken = () => new Error(`A baseline named "${withoutExtension(target)}" already exists`)
    if ((await exists(target)) && !sameFile) throw taken()
    if (basename(target) === basename(baseline.png)) return baseline
    const oldJson = this.json(baseline.png)
    const newJson = this.json(target)
    if ((await exists(newJson)) && !sameFile) throw taken()
    try {
      await fsRename(baseline.png, target)
    } catch {
      throw new Error(`Could not rename ${basename(baseline.png)}`)
    }
    if (await isFile(oldJson)) {
      try {
        await fsRename(oldJson, newJson)
      } catch {
        await fsRename(target, baseline.png).catch(() => undefined)
        throw new Error('Could not rename the baseline sidecar')
      }
    }
    return { name: withoutExtension(target), png: target, info: baseline.info }
  }

  async delete(baseline: Baseline): Promise<void> {
    await rm(baseline.png, { force: true })
    await rm(this.json(baseline.png), { force: true })
  }

  private writeInfo(png: string, info: BaselineInfo): Promise<void> {
    return writeFile(this.json(png), JSON.stringify(info, null, 2))
  }

  /** Undefined for a missing or unreadable sidecar (the baseline is still usable, without its remembered sizes). */
  async readInfo(file: string): Promise<BaselineInfo | undefined> {
    try {
      if (!(await isFile(file))) return undefined
      const o = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined
      const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0)
      const ignore = Array.isArray(o.ignore) ? (o.ignore as unknown[]).filter((r): r is number[] => Array.isArray(r) && r.every((n) => typeof n === 'number')) : []
      return new BaselineInfo({
        device: typeof o.device === 'string' ? o.device : '',
        logicalWidth: num('logicalWidth'),
        logicalHeight: num('logicalHeight'),
        frameWidth: num('frameWidth'),
        frameHeight: num('frameHeight'),
        savedAt: num('savedAt'),
        ignore,
      })
    } catch {
      return undefined
    }
  }
}
