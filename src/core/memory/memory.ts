// ported-from: core/memory/Memory.kt
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'

/** Levels accepted by `am send-trim-memory` (ComponentCallbacks2.TRIM_MEMORY_*), mildest first. */
export type TrimLevel = 'HIDDEN' | 'RUNNING_MODERATE' | 'BACKGROUND' | 'RUNNING_LOW' | 'MODERATE' | 'RUNNING_CRITICAL' | 'COMPLETE'

const TRIM: Record<TrimLevel, { label: string; hint: string }> = {
  HIDDEN: { label: 'Hidden', hint: 'UI is hidden (TRIM_MEMORY_UI_HIDDEN)' },
  RUNNING_MODERATE: { label: 'Running, moderate', hint: 'Running, device is getting low on memory' },
  BACKGROUND: { label: 'Background', hint: 'Process moved to the LRU list' },
  RUNNING_LOW: { label: 'Running, low', hint: 'Running, device is low on memory' },
  MODERATE: { label: 'Moderate', hint: 'Process is in the middle of the LRU list' },
  RUNNING_CRITICAL: { label: 'Running, critical', hint: 'Running, device is very low; background processes are being killed' },
  COMPLETE: { label: 'Complete', hint: 'Process is first in line to be killed' },
}

export const TrimLevels = {
  values: ['HIDDEN', 'RUNNING_MODERATE', 'BACKGROUND', 'RUNNING_LOW', 'MODERATE', 'RUNNING_CRITICAL', 'COMPLETE'] as readonly TrimLevel[],
  /** The argument of `am send-trim-memory` (the enum name). */
  arg: (l: TrimLevel): string => l,
  label: (l: TrimLevel): string => TRIM[l].label,
  hint: (l: TrimLevel): string => TRIM[l].hint,
}

export const MemoryCommands = {
  /** Package names and process names (`pkg:service`) only: the value is part of a remote shell command line. */
  validProcess: (name: string): boolean => name.length > 0 && name.length <= 256 && /^[A-Za-z0-9_.:]+$/.test(name),

  trim: (adb: string, serial: string, process: string, level: TrimLevel): string[] => [adb, '-s', serial, 'shell', 'am', 'send-trim-memory', process, TrimLevels.arg(level)],
}

export const MemoryParsers = {
  /** The error in the output of `am send-trim-memory` (it exits 0 for an unknown process), or undefined. */
  error(output: string): string | undefined {
    const hit = output
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find((l) => {
        const lower = l.toLowerCase()
        return (
          lower.startsWith('error') ||
          lower.startsWith('unknown') ||
          lower.startsWith('unable') ||
          l.includes('Exception') ||
          lower.includes('not found') ||
          lower.includes('no process') ||
          lower.startsWith('permission') ||
          lower.includes('bad')
        )
      })
    return hit?.slice(0, 200)
  },

  errorLine(text: string, stderr: string, exitCode: number): string {
    return [...stderr.split(/\r\n|\r|\n/), ...text.split(/\r\n|\r|\n/)].map((l) => l.trim()).find((l) => l.length > 0) ?? `Exit code ${exitCode}`
  },
}

/** Sends memory trim callbacks (onTrimMemory) to a running app of one Android device. */
export class AndroidMemory {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  async trim(process: string, level: TrimLevel): Promise<void> {
    if (!MemoryCommands.validProcess(process)) throw new CommandFailedException(`Not a valid package or process name: ${process}`)
    const r = await this.runner.run(MemoryCommands.trim(this.adb, this.serial, process, level), 10_000)
    if (!r.ok) throw new CommandFailedException(MemoryParsers.errorLine(r.text, r.stderr, r.exitCode))
    const err = MemoryParsers.error(r.text + '\n' + r.stderr)
    if (err !== undefined) throw new CommandFailedException(`${err} (is the app running?)`)
  }
}
