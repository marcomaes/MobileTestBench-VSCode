// ported-from: ui/DeviceViewerPanel.kt (region device power) and DeviceServices.powerCall
import type { Device } from '../core/model'
import { Polling, PowerActions, type PowerAction } from '../core/power/devicePower'
import type { DeviceServices } from '../deviceServices'

/** Device Power: how often and how long to look for a device that came up or went away, and the pause after a reboot command. */
export const POWER_POLL_MS = 2_000
export const POWER_UP_TIMEOUT_MS = 60_000
export const POWER_GONE_TIMEOUT_MS = 10_000
export const POWER_REBOOT_GRACE_MS = 3_000

export interface PowerOutcome {
  error?: string
  /** The usable entry of the device after a boot or reboot. */
  up?: Device
  timedOut: boolean
}

/** Runs a Device Power command (`device boot|shutdown|reboot`) with the action's own timeout. */
export async function powerCall(services: DeviceServices, device: Device, action: PowerAction): Promise<void> {
  await services.mobilecliCall(device, PowerActions.args(action), PowerActions.timeoutMs(action))
}

/**
 * The command plus the wait for the result: after a shutdown until the device is gone, after a boot or reboot until a usable
 * entry of the same device shows up. [stale] cancels the polling; [onWaiting] is told when the wait for a start begins.
 */
export async function runPowerAndWait(
  services: DeviceServices,
  action: PowerAction,
  device: Device,
  stale: () => boolean,
  onWaiting?: () => void,
  sleep?: (ms: number) => Promise<void>,
): Promise<PowerOutcome> {
  const out: PowerOutcome = { timedOut: false }
  try {
    await powerCall(services, device, action)
    if (action === 'SHUTDOWN') {
      // adb can list a just stopped emulator for a moment longer.
      await Polling.until({
        timeoutMs: POWER_GONE_TIMEOUT_MS,
        intervalMs: POWER_POLL_MS,
        cancelled: stale,
        sleep,
        probe: async () => (Polling.usableMatch((await services.discovery().discover()).devices, device) === undefined ? true : undefined),
      })
    } else {
      // After a reboot the old instance may still look usable for a moment.
      if (action === 'REBOOT') await (sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(POWER_REBOOT_GRACE_MS)
      if (!stale()) onWaiting?.()
      out.up = await Polling.until({
        timeoutMs: POWER_UP_TIMEOUT_MS,
        intervalMs: POWER_POLL_MS,
        cancelled: stale,
        sleep,
        probe: async () => Polling.usableMatch((await services.discovery().discover()).devices, device),
      })
      out.timedOut = out.up === undefined && !stale()
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  }
  return out
}
