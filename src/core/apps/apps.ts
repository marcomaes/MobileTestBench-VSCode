// ported-from: core/apps/Apps.kt
import type { CommandRunner } from '../exec/commandRunner'
import type { Device } from '../model'

/** One installed app as listed by `mobilecli apps list`. */
export interface AppInfo {
  id: string
  name: string
  version: string
}

export const appInfo = (id: string, name: string, version = ''): AppInfo => ({ id, name, version })

export const IOS_HOME = 'com.apple.springboard'

/** The app in front. [activity] is Android only; [isHome] is true on the iOS home screen (SpringBoard). */
export class ForegroundApp {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly activity?: string,
  ) {}

  get isHome(): boolean {
    return this.id === IOS_HOME
  }
}

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non blank primitive member as a string. */
function str(o: JsonObject, key: string): string | undefined {
  const v = o[key]
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined
  const s = String(v)
  return s.trim().length > 0 ? s : undefined
}

const lower = (s: string): string => s.toLowerCase()
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function app(o: JsonObject): AppInfo | undefined {
  const id = str(o, 'packageName')
  if (id === undefined) return undefined
  return { id, name: str(o, 'appName') ?? id, version: str(o, 'version') ?? '' }
}

/** Pure parsing, command building and validation for the app manager. */
export const Apps = {
  /** Parses the `data` of `apps list`, sorted by name (case-insensitive). Entries without a package name are dropped. */
  parseList(data: unknown): AppInfo[] {
    if (!Array.isArray(data)) return []
    return data
      .map((e) => (isObject(e) ? app(e) : undefined))
      .filter((a): a is AppInfo => a !== undefined)
      .sort((a, b) => compare(lower(a.name), lower(b.name)) || compare(a.id, b.id))
  },

  /** Parses the `data` of `apps foreground`; undefined when there is none. */
  parseForeground(data: unknown): ForegroundApp | undefined {
    if (!isObject(data)) return undefined
    const id = str(data, 'packageName')
    if (id === undefined) return undefined
    return new ForegroundApp(id, str(data, 'appName') ?? id, str(data, 'activity'))
  },

  /** Case-insensitive match of [query] against name or id; a blank query matches everything. */
  filter(apps: AppInfo[], query: string): AppInfo[] {
    const q = lower(query.trim())
    if (q.length === 0) return apps
    return apps.filter((a) => lower(a.name).includes(q) || lower(a.id).includes(q))
  },

  /** Package ids of `pm list packages -3` output (`package:com.x` lines); the third-party (user installed) apps. */
  parseUserPackages(text: string): Set<string> {
    const out = new Set<string>()
    for (const raw of text.split(/\r\n|\n|\r/)) {
      const line = raw.trim()
      if (!line.startsWith('package:')) continue
      const rest = line.slice('package:'.length)
      const id = rest.slice(rest.lastIndexOf('=') + 1).trim()
      if (id.length > 0) out.add(id)
    }
    return out
  },

  /**
   * mobilecli's list has no system flag. On Android an app is system when it is missing from [userPackages]
   * (`pm list packages -3`); with no such list (undefined) nothing counts as system. On iOS the `com.apple.` bundle id prefix marks system apps.
   */
  isSystem(device: Device, app: AppInfo, userPackages: ReadonlySet<string> | undefined): boolean {
    return device.platform === 'ANDROID' ? userPackages !== undefined && !userPackages.has(app.id) : app.id.startsWith('com.apple.')
  },

  /** Drops the system apps when [hide] is set; the app with id [keepId] (the selected one) always stays. */
  hideSystem(apps: AppInfo[], device: Device, userPackages: ReadonlySet<string> | undefined, hide: boolean, keepId?: string): AppInfo[] {
    return hide ? apps.filter((a) => a.id === keepId || !Apps.isSystem(device, a, userPackages)) : apps
  },

  /** `mobilecli apps clear` works on Android and on iOS simulators, not on physical iPhones. */
  canClearData: (device: Device): boolean => device.platform === 'ANDROID' || device.kind === 'SIMULATOR',

  /** Android-style activity names (`.MainActivity`, `com.x.Main`) only make sense on Android. */
  supportsActivity: (device: Device): boolean => device.platform === 'ANDROID',

  /** Arguments (without `--device`) for `apps launch`. Blank locale or activity are left out; the activity only on Android. */
  launchArgs(device: Device, id: string, locale = '', activity = ''): string[] {
    const args = ['apps', 'launch', id]
    if (locale.trim().length > 0) args.push('--locale', locale.trim().replaceAll(' ', ''))
    if (activity.trim().length > 0 && Apps.supportsActivity(device)) args.push('--activity', activity.trim())
    return args
  },

  terminateArgs: (id: string): string[] => ['apps', 'terminate', id],
  clearArgs: (id: string): string[] => ['apps', 'clear', id],
  uninstallArgs: (id: string): string[] => ['apps', 'uninstall', id],
  installArgs: (path: string): string[] => ['apps', 'install', path],

  INSTALL_EXTENSIONS: new Set(['apk', 'zip', 'ipa']),

  /** Why [path] cannot be installed on [device] (undefined when it can). Checks the extension only; mobilecli checks the content. */
  installProblem(device: Device, path: string): string | undefined {
    const dot = path.lastIndexOf('.')
    const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
    if (!Apps.INSTALL_EXTENSIONS.has(ext)) return 'Only .apk, .zip and .ipa files can be installed'
    if (device.platform === 'ANDROID' && ext !== 'apk') return 'An Android device needs an .apk file'
    if (device.platform === 'IOS' && device.kind === 'SIMULATOR' && ext === 'apk') return 'An iOS simulator needs a .zip (zipped .app) file'
    if (device.platform === 'IOS' && device.kind === 'SIMULATOR' && ext === 'ipa') return 'An iOS simulator needs a .zip (zipped .app) file, an .ipa is for real devices'
    if (device.platform === 'IOS' && device.kind === 'PHYSICAL' && ext !== 'ipa') return 'A real iPhone needs an .ipa file'
    return undefined
  },

  /** Turns opaque simctl failures into something readable; other messages pass through. Terminating an installed app that is not running succeeds, so status 3 means not installed. */
  friendlyError(message: string): string {
    if (message.includes('exit status 3')) return `${message} (app is not installed)`
    if (message.includes('exit status 4')) return `${message} (app is not installed)`
    return message
  },
}

/** Lists the user installed (third-party) Android packages with `adb shell pm list packages -3`. */
export class AndroidPackages {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  async userPackages(): Promise<Set<string>> {
    const r = await this.runner.run([this.adb, '-s', this.serial, 'shell', 'pm', 'list', 'packages', '-3'], 15_000)
    if (!r.ok) throw new Error(r.stderr.split(/\r\n|\n|\r/).find((l) => l.trim().length > 0) ?? 'pm list packages failed')
    return Apps.parseUserPackages(r.text)
  }
}
