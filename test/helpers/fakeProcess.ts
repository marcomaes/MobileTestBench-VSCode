import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { encode } from 'jpeg-js'
import { PNG } from 'pngjs'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'

export const png = (width: number, height: number): Buffer => PNG.sync.write(new PNG({ width, height }))
export const jpeg = (width: number, height: number): Buffer => encode({ data: Buffer.alloc(width * height * 4, 255), width, height }, 80).data

/** A started process that delivers [data] on stdout; with [open] it stays open until killed, like a running stream. */
export function fakeProcess(data: Buffer, open = false): ChildProcess {
  const process = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough }
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(process, { stdout, stderr })
  stdout.write(data)
  const finish = (): void => {
    stdout.end()
    stderr.end()
    process.emit('close', 0, null)
  }
  ;(process as { kill: () => boolean }).kill = () => {
    finish()
    return true
  }
  if (!open) setImmediate(finish)
  return process
}

/** Records every command (run and start); subclasses answer through [reply]/[startReply]. */
export class ScriptedRunner extends CommandRunner {
  readonly commands: string[][] = []
  constructor(
    private readonly reply: (command: string[]) => CommandResult,
    private readonly startReply: (command: string[]) => ChildProcess = () => {
      throw new Error('no stream')
    },
  ) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command)
    return this.reply(command)
  }
  override start(command: string[]): ChildProcess {
    this.commands.push(command)
    return this.startReply(command)
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return condition()
}
