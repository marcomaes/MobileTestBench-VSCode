// ported-from: core/exec/CommandRunner.kt
import { spawn, type ChildProcess } from 'node:child_process'

export class CommandResult {
  constructor(
    readonly exitCode: number,
    readonly stdout: Buffer,
    readonly stderr: string,
  ) {}
  get ok(): boolean {
    return this.exitCode === 0
  }
  get text(): string {
    return this.stdout.toString('utf8')
  }
}

export class CommandFailedException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandFailedException'
  }
}

/** The process did not start at all: the program is not installed or the configured path is wrong. */
export class CommandNotFoundException extends CommandFailedException {
  constructor(readonly program: string, cause?: string) {
    super(`Cannot start ${program}${cause ? `: ${cause}` : ''}`)
    this.name = 'CommandNotFoundException'
  }
}

/**
 * Small process runner. The environment is injected so the IDE can pass its login shell environment
 * (apps started from the macOS Dock have a minimal PATH).
 */
export class CommandRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  run(command: string[], timeoutMs = 20_000): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.start(command)
      const out: Buffer[] = []
      const err: Buffer[] = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new CommandFailedException(`Timed out after ${timeoutMs / 1000}s: ${command.join(' ')}`))
      }, timeoutMs)
      child.stdout?.on('data', (c: Buffer) => out.push(c))
      child.stderr?.on('data', (c: Buffer) => err.push(c))
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e.code === 'ENOENT' || e.code === 'EACCES' ? new CommandNotFoundException(command[0], e.message) : new CommandFailedException(e.message))
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Like the JVM, a process killed by a signal reports 128 + signal (SIGKILL is 137).
        const exit = code ?? (signal === 'SIGKILL' ? 137 : 128 + 15)
        resolve(new CommandResult(exit, Buffer.concat(out), Buffer.concat(err).toString('utf8')))
      })
    })
  }

  /** Runs the command and throws when it exits with a non zero code. */
  async runChecked(command: string[], timeoutMs = 20_000): Promise<CommandResult> {
    const result = await this.run(command, timeoutMs)
    if (!result.ok) {
      throw new CommandFailedException(`Exit code ${result.exitCode}: ${command.join(' ')}\n${result.stderr.trim()}`)
    }
    return result
  }

  /** Starts a long running process; the caller reads its streams and ends it with `kill`. */
  start(command: string[], stdin: 'ignore' | 'pipe' = 'ignore'): ChildProcess {
    return spawn(command[0], command.slice(1), { env: { ...this.environment }, stdio: [stdin, 'pipe', 'pipe'] })
  }
}
