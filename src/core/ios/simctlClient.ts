// ported-from: core/ios/SimctlClient.kt
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner } from '../exec/commandRunner'

export class SimctlClient {
  constructor(
    private readonly xcrun: string,
    private readonly runner: CommandRunner,
  ) {}

  /** Command line of the simulator log (long running; end it by ending the process). */
  logStreamCommand(udid: string): string[] {
    return [this.xcrun, 'simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--level', 'debug']
  }

  async listBootedJson(): Promise<string> {
    return (await this.runner.runChecked([this.xcrun, 'simctl', 'list', 'devices', 'booted', '-j'])).text
  }

  async screenshotPng(udid: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'mobiletestbench-sim-'))
    const file = join(dir, 'screen.png')
    try {
      await this.runner.runChecked([this.xcrun, 'simctl', 'io', udid, 'screenshot', '--type=png', file], 10_000)
      return await readFile(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
