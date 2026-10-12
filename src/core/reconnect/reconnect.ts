// ported-from: core/reconnect/Reconnect.kt
import type { DiscoveryResult } from '../discovery/deviceDiscovery'
import { isSameDevice, isUsable, type Device } from '../model'
import { Polling } from '../power/devicePower'

export type ReconnectPhase = 'IDLE' | 'CONNECTED' | 'WAITING'

export type ReconnectEvent =
  /** Nothing to do (device still there, or discovery gave no answer). */
  | { kind: 'None' }
  /** The device was missing or unusable for two polls in a row (or a session error plus one poll). */
  | { kind: 'Lost'; device: Device }
  /** Still waiting after a poll; [waitedMs] is the time since the loss. */
  | { kind: 'StillWaiting'; device: Device; waitedMs: number }
  /** The same device is usable again; [device] is the fresh entry (an emulator serial can differ after a boot). */
  | { kind: 'Reconnected'; device: Device }

export const ReconnectEvents = {
  None: { kind: 'None' } as ReconnectEvent,
  lost: (device: Device): ReconnectEvent => ({ kind: 'Lost', device }),
  stillWaiting: (device: Device, waitedMs: number): ReconnectEvent => ({ kind: 'StillWaiting', device, waitedMs }),
  reconnected: (device: Device): ReconnectEvent => ({ kind: 'Reconnected', device }),
}

const LOST_AFTER_MISSES = 2
const BASE_DELAY_MS = 3_000
const MAX_DELAY_MS = 10_000
const STEP_MS = 1_000

/**
 * The reconnect state machine: IDLE (not watching) -> CONNECTED (watching a live session) -> WAITING (lost, polling until it is back)
 * -> IDLE again once a Reconnected event was returned; the caller then connects and calls [watch] again.
 *
 * It never schedules anything itself: the caller calls [tick] every [pollDelayMs]. [discover] returns the discovered devices, or
 * undefined when discovery itself failed (an inconclusive poll, which changes nothing). Matching uses isSameDevice through
 * Polling.usableMatch, so an emulator that comes back with another adb serial is still the same device.
 */
export class ReconnectWatcher {
  static readonly LOST_AFTER_MISSES = LOST_AFTER_MISSES
  static readonly BASE_DELAY_MS = BASE_DELAY_MS
  static readonly MAX_DELAY_MS = MAX_DELAY_MS
  static readonly STEP_MS = STEP_MS

  phase: ReconnectPhase = 'IDLE'
  target: Device | undefined
  private misses = 0
  private attempts = 0
  private lostAt = 0

  constructor(
    private readonly discover: () => Promise<Device[] | undefined> | Device[] | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Start watching a connected device. */
  watch(device: Device): void {
    this.phase = 'CONNECTED'
    this.target = device
    this.misses = 0
    this.attempts = 0
  }

  /** Go straight to waiting (the caller shut the device down or rebooted it on purpose and wants it back). */
  waitFor(device: Device): void {
    this.phase = 'WAITING'
    this.target = device
    this.misses = 0
    this.attempts = 0
    this.lostAt = this.clock()
  }

  /** Stop (Disconnect, another device chosen, dispose, Cancel). */
  stop(): void {
    this.phase = 'IDLE'
    this.target = undefined
    this.misses = 0
    this.attempts = 0
  }

  /** The session reported an error: count it as one missed poll, so one more missing poll confirms the loss. */
  sessionFailed(): void {
    if (this.phase === 'CONNECTED' && this.misses < 1) this.misses = 1
  }

  /** How long to wait before the next [tick]: 3 s while connected, growing by 1 s per waiting poll up to 10 s. */
  pollDelayMs(): number {
    return this.phase === 'WAITING' ? Math.min(MAX_DELAY_MS, BASE_DELAY_MS + this.attempts * STEP_MS) : BASE_DELAY_MS
  }

  waitedMs(): number {
    return this.phase === 'WAITING' ? this.clock() - this.lostAt : 0
  }

  /** One poll. */
  async tick(): Promise<ReconnectEvent> {
    if (this.phase === 'IDLE') return ReconnectEvents.None
    const current = this.target!
    let devices: Device[] | undefined
    try {
      devices = await this.discover()
    } catch {
      devices = undefined
    }
    if (!devices) return ReconnectEvents.None
    const match = Polling.usableMatch(devices, current)
    // stop() or a new watch() may have happened while discovery ran: drop the stale answer.
    if ((this.phase as ReconnectPhase) === 'IDLE' || this.target !== current) return ReconnectEvents.None
    if (this.phase === 'CONNECTED') {
      if (match) {
        this.misses = 0
        return ReconnectEvents.None
      }
      if (++this.misses >= LOST_AFTER_MISSES) {
        this.phase = 'WAITING'
        this.attempts = 0
        this.lostAt = this.clock()
        return ReconnectEvents.lost(current)
      }
      return ReconnectEvents.None
    }
    if (match) {
      this.phase = 'IDLE'
      this.target = undefined
      return ReconnectEvents.reconnected(match)
    }
    this.attempts++
    return ReconnectEvents.stillWaiting(current, this.clock() - this.lostAt)
  }

  /**
   * Turns a discovery result into the watcher's input. Discovery never throws: a failing adb, simctl or mobilecli adds a warning and
   * the devices are just missing. So a result with warnings that does not list a usable [target] proves nothing and is inconclusive (undefined).
   */
  static conclusive(result: DiscoveryResult, target: Device | undefined): Device[] | undefined {
    return result.warnings.length > 0 && !result.devices.some((d) => isUsable(d) && isSameDevice(d, target)) ? undefined : result.devices
  }

  static waitingText(device: Device, waitedMs: number): string {
    return `Waiting for ${device.name} to come back...` + (waitedMs >= 10_000 ? ` (${Math.trunc(waitedMs / 1000)} s)` : '')
  }
}
