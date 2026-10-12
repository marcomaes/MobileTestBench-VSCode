// ported-from: core/android/EmulatorDiscovery.kt
import { readdir, readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

export interface EmulatorGrpcEndpoint {
  readonly host: string
  readonly port: number
  readonly token: string | undefined
}

const toInt = (s: string | undefined): number | undefined => {
  if (s === undefined || !/^[+-]?\d+$/.test(s.trim())) return undefined
  return Number(s.trim())
}

/**
 * Every running emulator writes a `pid_<pid>.ini` discovery file with its console port,
 * gRPC port and (optional) gRPC auth token. Android Studio uses the same files.
 */
export const EmulatorDiscovery = {
  parseIni(text: string): Map<string, string> {
    const values = new Map<string, string>()
    for (const raw of text.split(/\r?\n|\r/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || !line.includes('=')) continue
      const at = line.indexOf('=')
      values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
    return values
  },

  /** "emulator-5554" -> 5554 */
  consolePort(serial: string): number | undefined {
    return serial.startsWith('emulator-') ? toInt(serial.slice('emulator-'.length)) : undefined
  },

  endpointFromIni(values: Map<string, string>): EmulatorGrpcEndpoint | undefined {
    const port = toInt(values.get('grpc.port'))
    if (port === undefined) return undefined
    const token = values.get('grpc.token')
    return { host: 'localhost', port, token: token !== undefined && token.trim() !== '' ? token : undefined }
  },

  async findEndpoint(serial: string, directories: string[]): Promise<EmulatorGrpcEndpoint | undefined> {
    const console = EmulatorDiscovery.consolePort(serial)
    if (console === undefined) return undefined
    for (const dir of directories) {
      let names: string[]
      try {
        if (!(await stat(dir)).isDirectory()) continue
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names.filter((n) => n.startsWith('pid_') && n.endsWith('.ini'))) {
        let values: Map<string, string>
        try {
          values = EmulatorDiscovery.parseIni(await readFile(join(dir, name), 'utf8'))
        } catch {
          continue
        }
        if (toInt(values.get('port.serial')) === console) return EmulatorDiscovery.endpointFromIni(values)
      }
    }
    return undefined
  },

  /** [osName] is Node's `process.platform` (darwin, win32, linux) or a Java style os.name ("Mac OS X"). */
  defaultDirectories(env: Record<string, string | undefined>, osName: string, userHome: string): string[] {
    const os = osName.toLowerCase()
    const dirs: string[] = []
    if (env.ANDROID_EMULATOR_HOME) dirs.push(join(env.ANDROID_EMULATOR_HOME, 'running'))
    if (os.includes('mac') || os.includes('darwin')) dirs.push(join(userHome, 'Library/Caches/TemporaryItems/avd/running'))
    else if (os.includes('win')) {
      if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Temp/avd/running'))
    } else {
      if (env.XDG_RUNTIME_DIR) dirs.push(join(env.XDG_RUNTIME_DIR, 'avd/running'))
      dirs.push(`/tmp/android-${env.USER ?? userInfo().username}/avd/running`)
    }
    return dirs
  },
}
