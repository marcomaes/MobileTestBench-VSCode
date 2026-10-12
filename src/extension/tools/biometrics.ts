// ported-from: ui/BiometricsPanel.kt
// Host half of the Biometrics tab. iOS simulator: enrol / unenrol Face ID or Touch ID and send matching or non-matching notifications
// through `simctl spawn notifyutil`. Android emulator: touch the fingerprint sensor with a finger id (`adb emu finger touch`).
import { BiometricCommands, IosBiometries, type BiometricResult, type IosBiometry } from '../../core/biometrics/biometrics'
import type { ToolContext, ToolHost } from './toolHost'

export interface BiometricsConfigDto {
  mode: 'ios' | 'android' | 'none'
  connected: boolean
  header: string
  note: string
  matchLabel: string
  noMatchLabel: string
}

const msg = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e))

function biometryOf(ctx: ToolContext): IosBiometry {
  return ctx.device.platform === 'IOS' ? BiometricCommands.biometryFor(ctx.device.name) : 'FACE_ID'
}

function configure(ctx: ToolContext): BiometricsConfigDto {
  const d = ctx.device
  const ios = ctx.services.iosBiometrics(d)
  const android = ctx.services.androidBiometrics(d)
  const biometry = biometryOf(ctx)
  const label = IosBiometries.label(biometry)
  const isIos = d.platform === 'IOS'
  const isAndroid = d.platform === 'ANDROID'
  return {
    mode: ios ? 'ios' : android ? 'android' : 'none',
    connected: true,
    header:
      isIos && ios
        ? `${label} (${d.name}). The type is guessed from the model name; simctl does not report it.`
        : isIos
          ? 'Biometrics need an iOS simulator. A physical iPhone cannot be driven from here.'
          : isAndroid && android
            ? `Fingerprint sensor of the emulator ${d.id}`
            : 'Biometrics need an Android emulator: the sensor is reached through the emulator console (adb emu), which a physical Android device does not have.',
    note: ios
      ? `Enroll first, then start an app that asks for ${label}: Matching / Non-matching only act while such a prompt is showing, and they always report only that the notification was posted (notifyutil exits 0 for any name). The enrolled state shown is what this tab or an earlier notifyutil call set; it can differ from Simulator.app's Features menu.`
      : android
        ? 'Enrol a fingerprint first: set a screen lock in Settings > Security, then Settings > Security > Fingerprint, and press Touch sensor here for every scan step. The extension cannot set a screen lock or enrol for you (there is no shell command for it). The console replies OK even when nothing is enrolled, so OK is not proof of a match: the enrolled count below is the check.'
        : ' ',
    matchLabel: `Matching ${IosBiometries.subject(biometry)}`,
    noMatchLabel: `Non-matching ${IosBiometries.subject(biometry)}`,
  }
}

/** The "State: ..." line (Kotlin `refreshState`). */
async function readState(ctx: ToolContext): Promise<string> {
  const ios = ctx.services.iosBiometrics(ctx.device)
  const android = ctx.services.androidBiometrics(ctx.device)
  try {
    if (ios) {
      switch (await ios.readEnrolled()) {
        case true:
          return 'State: enrolled (as set by this tab or notifyutil)'
        case false:
          return 'State: not enrolled (as set by this tab or notifyutil; Face ID / Touch ID may also be enrolled through Simulator.app)'
        default:
          return 'State: unknown'
      }
    }
    if (!android) return ' '
    const prints = await android.prints()
    if (prints.length === 0) return 'Enrolled fingerprints: unknown (dumpsys fingerprint showed no entries)'
    const sum = (f: (p: (typeof prints)[number]) => number): number => prints.reduce((s, p) => s + f(p), 0)
    return `Enrolled fingerprints: ${sum((p) => p.count)}  (accepted ${sum((p) => p.accept)}, rejected ${sum((p) => p.reject)} since boot)`
  } catch (e) {
    return `State could not be read: ${msg(e)}`
  }
}

async function execute(ctx: ToolContext, action: string, fingerId: string): Promise<BiometricResult> {
  try {
    const ios = ctx.services.iosBiometrics(ctx.device)
    const android = ctx.services.androidBiometrics(ctx.device)
    const biometry = biometryOf(ctx)
    switch (action) {
      case 'enroll':
        return await ios!.enroll()
      case 'unenroll':
        return await ios!.unenroll()
      case 'match':
        return await ios!.match(biometry)
      case 'noMatch':
        return await ios!.noMatch(biometry)
      case 'touch': {
        const [id, err] = BiometricCommands.parseFingerId(fingerId)
        return id === undefined ? { text: err!, error: true } : await android!.touch(id)
      }
      case 'lift':
        return await android!.lift()
      default:
        throw new Error(`Biometrics: unknown action ${action}`)
    }
  } catch (e) {
    return { text: msg(e), error: true }
  }
}

export const biometricsHost: ToolHost = {
  id: 'biometrics',
  title: 'Biometrics',
  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'configure':
        return configure(ctx)
      case 'state':
        return { text: await readState(ctx) }
      case 'run':
        return execute(ctx, String(p.action), String(p.fingerId ?? ''))
      default:
        throw new Error(`Biometrics: unknown method ${method}`)
    }
  },
}
