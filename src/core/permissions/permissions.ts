// ported-from: core/permissions/Permissions.kt
import type { CommandResult, CommandRunner } from '../exec/commandRunner'

const lines = (s: string): string[] => s.split(/\r\n|\n|\r/)

/** One runtime permission of an Android app as `dumpsys package` reports it. */
export class RuntimePermission {
  constructor(
    readonly name: string,
    readonly granted: boolean,
    readonly flags: ReadonlySet<string> = new Set(),
  ) {}

  /** `CAMERA` for `android.permission.CAMERA`; other namespaces keep their full name. */
  get shortName(): string {
    return this.name.startsWith('android.permission.') ? this.name.slice('android.permission.'.length) : this.name
  }

  /** The user chose "don't ask again": after a revoke the app gets no prompt until this flag is cleared. */
  get userFixed(): boolean {
    return this.flags.has('USER_FIXED')
  }
}

/** [runtime] can be granted and revoked; [installTimeCount] permissions are fixed at install and cannot be changed. */
export interface PermissionSet {
  runtime: RuntimePermission[]
  installTimeCount: number
}

/** What one permission action did: the command that ran and either its success or the first useful error line. */
export class PermissionResult {
  constructor(
    readonly commandLine: string,
    readonly ok: boolean,
    readonly message: string,
  ) {}

  get text(): string {
    return this.ok ? `${this.commandLine}: done` : `${this.commandLine}: ${this.message}`
  }
}

/** The iOS privacy actions of `simctl privacy`. */
export interface IosPrivacyAction {
  readonly name: string
  readonly simctl: string
  readonly label: string
}

const action = (name: string, simctl: string, label: string): IosPrivacyAction => ({ name, simctl, label })
export const IosPrivacyActions = {
  GRANT: action('GRANT', 'grant', 'Grant'),
  REVOKE: action('REVOKE', 'revoke', 'Revoke'),
  RESET: action('RESET', 'reset', 'Reset'),
}

/** The privacy services `simctl privacy` knows. [documented] is false for camera: accepted by simctl but not in its help text. */
export interface IosPrivacyService {
  readonly name: string
  readonly simctl: string
  readonly label: string
  readonly documented: boolean
  /** Shown next to the service when it is not part of the simctl help. */
  readonly note: string | undefined
}

const service = (name: string, simctl: string, label: string, documented = true): IosPrivacyService => ({
  name,
  simctl,
  label,
  documented,
  note: documented ? undefined : 'accepted by simctl but not in its help text',
})

export const IosPrivacyServices = {
  ALL: service('ALL', 'all', 'All services'),
  CALENDAR: service('CALENDAR', 'calendar', 'Calendar'),
  CONTACTS: service('CONTACTS', 'contacts', 'Contacts'),
  CONTACTS_LIMITED: service('CONTACTS_LIMITED', 'contacts-limited', 'Contacts (limited)'),
  LOCATION: service('LOCATION', 'location', 'Location (while in use)'),
  LOCATION_ALWAYS: service('LOCATION_ALWAYS', 'location-always', 'Location (always)'),
  PHOTOS: service('PHOTOS', 'photos', 'Photos'),
  PHOTOS_ADD: service('PHOTOS_ADD', 'photos-add', 'Photos (add only)'),
  MEDIA_LIBRARY: service('MEDIA_LIBRARY', 'media-library', 'Media library'),
  MICROPHONE: service('MICROPHONE', 'microphone', 'Microphone'),
  CAMERA: service('CAMERA', 'camera', 'Camera', false),
  MOTION: service('MOTION', 'motion', 'Motion and fitness'),
  REMINDERS: service('REMINDERS', 'reminders', 'Reminders'),
  SIRI: service('SIRI', 'siri', 'Siri'),
}

/** All services in declaration order (the Kotlin `IosPrivacyService.values()`). */
export const iosPrivacyServices = (): IosPrivacyService[] => Object.values(IosPrivacyServices)

const permLine = /^\s+(\S+): granted=(true|false)(?:, flags=\[(.*)\])?\s*$/
const namePattern = /^[A-Za-z0-9._]+$/
const bundlePattern = /^[A-Za-z0-9._-]+$/

/** The lines after [headerAt] that are indented deeper than the header. */
function block(all: string[], headerAt: number): string[] {
  const leading = (l: string): number => l.length - l.replace(/^ +/, '').length
  const indent = leading(all[headerAt])
  const out: string[] = []
  for (let i = headerAt + 1; i < all.length; i++) {
    const line = all[i]
    if (line.trim().length === 0 || leading(line) <= indent) break
    out.push(line)
  }
  return out
}

/** Pure parsing, command building and error extraction for the permission dialog. */
export const Permissions = {
  /** True for a package or permission name that is safe to pass to a device shell. */
  validName: (name: string): boolean => namePattern.test(name),

  /**
   * Parses `dumpsys package <pkg>`: the first `runtime permissions:` block (the changeable ones) and the count of the
   * first `install permissions:` block. Updated system apps are printed twice; the first block with a runtime section wins.
   */
  parseDumpsys(text: string): PermissionSet {
    const all = lines(text)
    const runtimeAt = all.findIndex((l) => l.trim() === 'runtime permissions:')
    const seen = new Set<string>()
    const runtime: RuntimePermission[] = []
    if (runtimeAt >= 0) {
      for (const line of block(all, runtimeAt)) {
        const m = permLine.exec(line)
        if (!m || seen.has(m[1])) continue
        seen.add(m[1])
        const flags = new Set((m[3] ?? '').split('|').map((f) => f.trim()).filter((f) => f.length > 0))
        runtime.push(new RuntimePermission(m[1], m[2] === 'true', flags))
      }
    }
    const installAt = all.findIndex((l) => l.trim() === 'install permissions:')
    const install = installAt < 0 ? 0 : block(all, installAt).filter((l) => permLine.test(l)).length
    return { runtime, installTimeCount: install }
  },

  dumpsysArgs: (pkg: string): string[] => ['shell', 'dumpsys', 'package', pkg],
  grantArgs: (pkg: string, permission: string): string[] => ['shell', 'pm', 'grant', pkg, permission],
  revokeArgs: (pkg: string, permission: string): string[] => ['shell', 'pm', 'revoke', pkg, permission],

  /** Clears one "user decided" flag (`user-set`, `user-fixed`) so the app can ask again. */
  clearFlagArgs: (pkg: string, permission: string, flag: string): string[] => ['shell', 'pm', 'clear-permission-flags', pkg, permission, flag],

  /** `xcrun simctl privacy <udid> <action> <service> <bundle>`; the bundle id is always passed (a reset without one would hit every app). */
  iosArgs: (udid: string, action: IosPrivacyAction, service: IosPrivacyService, bundle: string): string[] => ['simctl', 'privacy', udid, action.simctl, service.simctl, bundle],

  validBundle: (bundle: string): boolean => bundlePattern.test(bundle),

  /**
   * The one line worth showing from the output of a failed command: the `java.` exception line of a pm stack trace,
   * else a `Failure [...]` line, else the first non blank line. Both streams are looked at, stdout first.
   */
  errorLine(stdout: string, stderr: string): string {
    const all = [...lines(stdout), ...lines(stderr)].map((l) => l.trim()).filter((l) => l.length > 0)
    return all.find((l) => l.startsWith('java.')) ?? all.find((l) => l.startsWith('Failure')) ?? all[0] ?? 'failed without output'
  },

  /** pm can exit 0 with a stack trace in rare cases; treat an exception or Failure line as an error too. */
  failed(result: CommandResult): boolean {
    return !result.ok || lines(result.text + '\n' + result.stderr).some((l) => l.trim().startsWith('java.') || l.trim().startsWith('Failure'))
  },
}

const FLAGS = ['user-set', 'user-fixed']

/** Reads and changes the runtime permissions of Android apps through adb. */
export class AndroidPermissions {
  static readonly FLAGS = FLAGS

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  /** Throws with the first error line when the package cannot be read. */
  async read(pkg: string): Promise<PermissionSet> {
    if (!Permissions.validName(pkg)) throw new Error(`Invalid package name: ${pkg}`)
    const result = await this.runner.run(this.command(Permissions.dumpsysArgs(pkg)), 15_000)
    if (!result.ok) throw new Error(Permissions.errorLine(result.text, result.stderr))
    return Permissions.parseDumpsys(result.text)
  }

  grant(pkg: string, permission: string): Promise<PermissionResult> {
    return this.exec(Permissions.grantArgs(pkg, permission))
  }

  revoke(pkg: string, permission: string): Promise<PermissionResult> {
    return this.exec(Permissions.revokeArgs(pkg, permission))
  }

  /**
   * Android has no per-app reset (`pm reset-permissions` resets every app, so it is never used). This revokes each runtime
   * permission and clears its user-set and user-fixed flags so the app can prompt again. One result per command.
   */
  async resetAll(pkg: string, permissions: RuntimePermission[]): Promise<PermissionResult[]> {
    const out: PermissionResult[] = []
    for (const p of permissions) {
      out.push(await this.revoke(pkg, p.name))
      for (const f of FLAGS) out.push(await this.exec(Permissions.clearFlagArgs(pkg, p.name, f)))
    }
    return out
  }

  private async exec(args: string[]): Promise<PermissionResult> {
    const shown = 'adb ' + args.join(' ')
    if (args.slice(3).some((a) => !Permissions.validName(a) && !FLAGS.includes(a))) return new PermissionResult(shown, false, 'invalid name')
    try {
      const r = await this.runner.run(this.command(args), 15_000)
      return Permissions.failed(r) ? new PermissionResult(shown, false, Permissions.errorLine(r.text, r.stderr)) : new PermissionResult(shown, true, '')
    } catch (e) {
      return new PermissionResult(shown, false, e instanceof Error ? e.message : String(e))
    }
  }

  private command(args: string[]): string[] {
    return [this.adb, '-s', this.serial, ...args]
  }
}

/** Sets the privacy services of one iOS simulator app through `simctl privacy`. The state cannot be read back. */
export class IosPermissions {
  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
  ) {}

  async apply(action: IosPrivacyAction, service: IosPrivacyService, bundle: string): Promise<PermissionResult> {
    const args = Permissions.iosArgs(this.udid, action, service, bundle)
    const shown = `xcrun simctl privacy ${action.simctl} ${service.simctl} ${bundle}`
    if (!Permissions.validBundle(bundle)) return new PermissionResult(shown, false, 'invalid bundle id')
    try {
      const r = await this.runner.run([this.xcrun, ...args], 15_000)
      return r.ok ? new PermissionResult(shown, true, '') : new PermissionResult(shown, false, Permissions.errorLine(r.text, r.stderr))
    } catch (e) {
      return new PermissionResult(shown, false, e instanceof Error ? e.message : String(e))
    }
  }
}
