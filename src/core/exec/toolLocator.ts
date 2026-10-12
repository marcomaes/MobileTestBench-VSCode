// ported-from: core/exec/ToolLocator.kt
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir, platform } from 'node:os'

const canExecute = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Finds adb and xcrun without relying on the editor having the user's shell PATH. */
export class ToolLocator {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly os: NodeJS.Platform = platform(),
    private readonly userHome: string = homedir(),
    private readonly fallbackDirs: string[] = ['/opt/homebrew/bin', '/usr/local/bin'],
    private readonly executable: (path: string) => boolean = canExecute,
  ) {}

  get isMac(): boolean {
    return this.os === 'darwin'
  }
  get isWindows(): boolean {
    return this.os === 'win32'
  }

  adb(): string {
    const exe = this.isWindows ? 'adb.exe' : 'adb'
    const roots: string[] = []
    if (this.environment.ANDROID_HOME) roots.push(this.environment.ANDROID_HOME)
    if (this.environment.ANDROID_SDK_ROOT) roots.push(this.environment.ANDROID_SDK_ROOT)
    if (this.isMac) roots.push(`${this.userHome}/Library/Android/sdk`)
    else if (this.isWindows) {
      if (this.environment.LOCALAPPDATA) roots.push(`${this.environment.LOCALAPPDATA}\\Android\\Sdk`)
    } else roots.push(`${this.userHome}/Android/Sdk`)
    const found = roots.map((r) => join(r, 'platform-tools', exe)).find((p) => this.executable(p))
    return found ?? this.findOnPath(exe) ?? exe
  }

  xcrun(): string {
    return this.executable('/usr/bin/xcrun') ? '/usr/bin/xcrun' : 'xcrun'
  }

  /** The mobilecli npm/brew binary, or undefined when it is not installed (physical iOS then stays unavailable). */
  mobilecli(): string | undefined {
    const exe = this.isWindows ? 'mobilecli.exe' : 'mobilecli'
    return this.findOnPath(exe) ?? this.fallbackDirs.map((d) => join(d, exe)).find((p) => this.executable(p))
  }

  private findOnPath(exe: string): string | undefined {
    const path = this.environment.PATH ?? this.environment.Path
    if (!path) return undefined
    return path
      .split(delimiter)
      .map((d) => join(d, exe))
      .find((p) => this.executable(p))
  }
}
