// ported-from: core/notifications/Notifications.kt
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner } from '../exec/commandRunner'
import { NotificationCommands, type AndroidPost, type IntentSpec, type NotificationResult } from './notifications'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Runs the commands. */
export class IosNotifications {
  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
  ) {}

  /** Sends [payload] (compact JSON) to [bundleId]. The payload goes through a temporary file that is deleted again. */
  async push(bundleId: string, payload: string): Promise<NotificationResult> {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'jbvm-push-'))
      const file = join(dir, 'payload.json')
      await writeFile(file, Buffer.from(payload, 'utf8'))
      const r = await this.runner.run(NotificationCommands.iosPush(this.xcrun, this.udid, bundleId, file), 20_000)
      return NotificationCommands.interpretIosPush(r.exitCode, r.text, r.stderr)
    } catch (e) {
      return { text: message(e), error: true }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
}

export class AndroidNotifications {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  private shell(command: string) {
    return this.runner.run(NotificationCommands.adbShell(this.adb, this.serial, command), 20_000)
  }

  post(p: AndroidPost): Promise<NotificationResult> {
    return this.attempt(async () => {
      const r = await this.shell(NotificationCommands.androidPost(p))
      return NotificationCommands.interpretAndroidPost(r.exitCode, r.text, r.stderr)
    })
  }

  broadcast(i: IntentSpec): Promise<NotificationResult> {
    return this.attempt(async () => {
      const r = await this.shell(NotificationCommands.androidBroadcast(i))
      return NotificationCommands.interpretBroadcast(r.exitCode, r.text, r.stderr)
    })
  }

  /** Cancels the shell package's notifications (binder transaction 1, verified on Android 17 only), then lists to verify. */
  clearShell(): Promise<NotificationResult> {
    return this.attempt(async () => {
      await this.shell(NotificationCommands.CLEAR_SHELL)
      const left = NotificationCommands.shellNotificationCount((await this.shell(NotificationCommands.LIST)).text)
      if (left === 0) return { text: 'Cleared: no shell notifications left', error: false }
      return { text: `${left} shell notification(s) remain. The cancel call is version specific; swipe them away in the shade instead.`, error: true }
    })
  }

  private async attempt(block: () => Promise<NotificationResult>): Promise<NotificationResult> {
    try {
      return await block()
    } catch (e) {
      return { text: message(e), error: true }
    }
  }
}
