// ported-from: core/recording/ScreenRecording.kt
import type { ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { CommandRunner } from '../exec/commandRunner'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A running screen recording: a `mobilecli screenrecord` process writing an MP4 file until it is stopped. */
export class ScreenRecording {
  private constructor(
    private readonly process: ChildProcess,
    readonly output: string,
    private readonly errors: { text: string },
    private readonly closed: Promise<void>,
  ) {}

  get isAlive(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null
  }

  /** Ends the recording and waits for the MP4 to be finalized. Rejects with mobilecli's message when no file was written. */
  async stop(timeoutMs = 10_000): Promise<string> {
    if (this.isAlive) {
      this.process.kill('SIGTERM')
      const done = await Promise.race([this.closed.then(() => true), sleep(timeoutMs).then(() => false)])
      if (!done) {
        this.process.kill('SIGKILL')
        await Promise.race([this.closed, sleep(2_000)])
      }
    }
    const size = await stat(this.output).then((s) => (s.isFile() ? s.size : 0), () => 0)
    if (size > 0) return this.output
    throw new Error(this.errors.text.trim() || 'The recording file is empty')
  }

  /**
   * Starts [command] (see `MobilecliClient.screenRecordCommand`). Fails with mobilecli's message when the process
   * ends within [startupMs], e.g. for an unknown device.
   */
  static async start(runner: CommandRunner, command: string[], output: string, startupMs = 1_000): Promise<ScreenRecording> {
    const child = runner.start(command)
    const errors = { text: '' }
    // Drain both streams so the process never blocks on a full pipe, keeping the first few KB for error messages.
    for (const s of [child.stdout, child.stderr]) {
      s?.on('data', (c: Buffer) => {
        if (errors.text.length < 4096) errors.text += c.toString('utf8')
      })
    }
    let spawnError: Error | undefined
    const closed = new Promise<void>((resolve) => {
      child.on('error', (e) => {
        spawnError = e
        resolve()
      })
      child.on('close', () => resolve())
    })
    const exitedEarly = await Promise.race([closed.then(() => true), sleep(startupMs).then(() => false)])
    if (exitedEarly) {
      await sleep(50) // let the drain collect the last output
      if (spawnError) throw new Error(`Cannot start ${command[0]}: ${spawnError.message}`)
      throw new Error(errors.text.trim() || `mobilecli stopped with exit code ${child.exitCode}`)
    }
    return new ScreenRecording(child, output, errors, closed)
  }
}
