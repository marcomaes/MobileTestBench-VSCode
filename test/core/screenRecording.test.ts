// ported-from: test:core/ScreenRecordingTest.kt
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AdbClient } from '../../src/core/android/adbClient'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { makeDevice } from '../../src/core/model'
import { ScreenRecording } from '../../src/core/recording/screenRecording'

class ShellRunner extends CommandRunner {
  constructor(private readonly script: string) {
    super({})
  }
  override start(): ChildProcess {
    return spawn('sh', ['-c', this.script], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

const out = () => join(mkdtempSync(join(tmpdir(), 'rec-')), 'rec.mp4')
const sh = existsSync('/bin/sh')

describe('ScreenRecordingTest', () => {
  it('the command records to the given file without progress output', () => {
    const client = new MobilecliClient('/bin/mobilecli', new CommandRunner({}))
    expect(client.screenRecordCommand('Pixel_9', '/tmp/a.mp4')).toEqual(['/bin/mobilecli', 'screenrecord', '--device', 'Pixel_9', '-o', '/tmp/a.mp4', '--silent'])
  })

  it.runIf(sh)('stopping a running recording returns the finished file', async () => {
    const file = out()
    try {
      // Writes the "file" at once and then keeps running, like mobilecli does.
      const recording = await ScreenRecording.start(new ShellRunner(`echo mp4 > '${file}'; exec sleep 30`), ['x'], file, 200)
      expect(recording.isAlive).toBe(true)
      expect(await recording.stop(5000)).toBe(file)
      expect(recording.isAlive).toBe(false)
    } finally {
      rmSync(file, { force: true })
    }
  })

  it.runIf(sh)('a recording that never wrote a file fails when stopped', async () => {
    const recording = await ScreenRecording.start(new ShellRunner('exec sleep 30'), ['x'], out(), 200)
    await expect(recording.stop(5000)).rejects.toThrow()
  })

  it.runIf(sh)("a process that ends at once reports mobilecli's message", async () => {
    await expect(ScreenRecording.start(new ShellRunner("echo 'device not found: X' >&2; exit 1"), ['x'], '/tmp/none.mp4', 3000)).rejects.toThrow(/device not found: X/)
  })

  it('an emulator is addressed by its AVD name, other devices by their id', async () => {
    const runner = new (class extends CommandRunner {
      override async run(): Promise<CommandResult> {
        return new CommandResult(0, Buffer.from('Pixel_9\r\nOK\r\n'), '')
      }
    })({})
    const adb = new AdbClient('adb', runner)
    expect(await MobilecliClient.idFor(makeDevice({ id: 'emulator-5554', name: 'Pixel 9', platform: 'ANDROID', kind: 'EMULATOR' }), adb)).toBe('Pixel_9')
    expect(await MobilecliClient.idFor(makeDevice({ id: 'R5CT123', name: 'Galaxy', platform: 'ANDROID', kind: 'PHYSICAL' }), adb)).toBe('R5CT123')
    expect(await MobilecliClient.idFor(makeDevice({ id: 'F236-UDID', name: 'iPhone', platform: 'IOS', kind: 'SIMULATOR' }), adb)).toBe('F236-UDID')
  })
})
