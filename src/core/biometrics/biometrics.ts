// ported-from: core/biometrics/Biometrics.kt
import { CommandFailedException, type CommandRunner } from '../exec/commandRunner'

/** Face ID or Touch ID, as far as it can be told from the simulator model name. */
export type IosBiometry = 'FACE_ID' | 'TOUCH_ID'

const BIOMETRY: Record<IosBiometry, { label: string; subject: string; matchNotification: string; noMatchNotification: string }> = {
  FACE_ID: { label: 'Face ID', subject: 'face', matchNotification: 'com.apple.BiometricKit_Sim.pearl.match', noMatchNotification: 'com.apple.BiometricKit_Sim.pearl.nomatch' },
  TOUCH_ID: { label: 'Touch ID', subject: 'finger', matchNotification: 'com.apple.BiometricKit_Sim.fingerTouch.match', noMatchNotification: 'com.apple.BiometricKit_Sim.fingerTouch.nomatch' },
}

export const IosBiometries = {
  label: (b: IosBiometry): string => BIOMETRY[b].label,
  subject: (b: IosBiometry): string => BIOMETRY[b].subject,
  matchNotification: (b: IosBiometry): string => BIOMETRY[b].matchNotification,
  noMatchNotification: (b: IosBiometry): string => BIOMETRY[b].noMatchNotification,
}

/** Reply of the Android emulator console: the first line is `OK` or `KO: reason`. */
export type EmuReply = { readonly kind: 'Ok' } | { readonly kind: 'Ko'; readonly reason: string }

export const EmuReply = {
  Ok: { kind: 'Ok' } as EmuReply,
  Ko: (reason: string): EmuReply => ({ kind: 'Ko', reason }),
}

/** Enrolled fingerprint templates in `dumpsys fingerprint`: [id] is the user bucket, [count] the number of templates in it. */
export interface FingerprintPrints {
  readonly id: number
  readonly count: number
  readonly accept: number
  readonly reject: number
}

const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)

/** Pure command building and parsing. */
export const BiometricCommands = {
  ENROLLMENT: 'com.apple.BiometricKit.enrollmentChanged',
  MIN_FINGER_ID: 1,
  MAX_FINGER_ID: 10,

  /**
   * Face ID unless the model name says a home button / Touch ID device (iPhone SE, iPhone 8 and older, iPads other than the Face ID Pros: every iPad
   * Pro except 9.7-inch, 10.5-inch and 12.9-inch 1st/2nd generation). A guess: simctl does not report it.
   */
  biometryFor(modelName: string): IosBiometry {
    const n = modelName.trim()
    if (/iPhone SE/i.test(n)) return 'TOUCH_ID'
    if (/^iPhone\s+([5-8])s?(\s+Plus)?$/i.test(n)) return 'TOUCH_ID'
    if (n.toLowerCase().startsWith('ipad')) {
      const facePro = /Pro/i.test(n) && !/9\.7|10\.5|12\.9-inch\)\s*\((1st|2nd)/i.test(n)
      return facePro ? 'FACE_ID' : 'TOUCH_ID'
    }
    return 'FACE_ID'
  },

  /** Enrolling is two processes: set the state to 1, then post the notification. Run them in order. */
  iosEnroll: (xcrun: string, udid: string): string[][] => [spawn(xcrun, udid, '-s', BiometricCommands.ENROLLMENT, '1'), spawn(xcrun, udid, '-p', BiometricCommands.ENROLLMENT)],
  iosUnenroll: (xcrun: string, udid: string): string[][] => [spawn(xcrun, udid, '-s', BiometricCommands.ENROLLMENT, '0'), spawn(xcrun, udid, '-p', BiometricCommands.ENROLLMENT)],
  iosReadEnrollment: (xcrun: string, udid: string): string[] => spawn(xcrun, udid, '-g', BiometricCommands.ENROLLMENT),
  iosMatch: (xcrun: string, udid: string, b: IosBiometry): string[] => spawn(xcrun, udid, '-p', IosBiometries.matchNotification(b)),
  iosNoMatch: (xcrun: string, udid: string, b: IosBiometry): string[] => spawn(xcrun, udid, '-p', IosBiometries.noMatchNotification(b)),

  validFingerId: (id: number): boolean => Number.isInteger(id) && id >= BiometricCommands.MIN_FINGER_ID && id <= BiometricCommands.MAX_FINGER_ID,

  /** Parses the finger id field; [undefined, message] when it is not 1..10. */
  parseFingerId(text: string): [number | undefined, string | undefined] {
    const t = text.trim()
    const id = /^[+-]?\d+$/.test(t) ? Number(t) : undefined
    return id !== undefined && BiometricCommands.validFingerId(id)
      ? [id, undefined]
      : [undefined, `Finger id must be a whole number from ${BiometricCommands.MIN_FINGER_ID} to ${BiometricCommands.MAX_FINGER_ID}`]
  },

  androidTouch(adb: string, serial: string, id: number): string[] {
    if (!BiometricCommands.validFingerId(id)) throw new Error(`Finger id must be ${BiometricCommands.MIN_FINGER_ID}..${BiometricCommands.MAX_FINGER_ID}`)
    return [adb, '-s', serial, 'emu', 'finger', 'touch', String(id)]
  },

  androidLift: (adb: string, serial: string): string[] => [adb, '-s', serial, 'emu', 'finger', 'remove'],
  androidDump: (adb: string, serial: string): string[] => [adb, '-s', serial, 'shell', 'dumpsys', 'fingerprint'],

  /** `adb emu` always exits 0, so the first line decides: `OK` or `KO: reason`. Undefined when neither (for example help text only). */
  parseEmuReply(stdout: string): EmuReply | undefined {
    const all = lines(stdout).map((l) => l.trim()).filter((l) => l.length > 0)
    const ko = all.find((l) => l.startsWith('KO'))
    if (ko !== undefined) return EmuReply.Ko(ko.slice(2).replace(/^[: ]+/, '').trim() || 'unknown')
    return all[0] === 'OK' ? EmuReply.Ok : undefined
  },

  /** `notifyutil -g` prints `<name> <state>`; true for a non-zero state. Undefined when not parseable. */
  parseEnrollment(stdout: string): boolean | undefined {
    const last = lines(stdout).map((l) => l.trim()).filter((l) => l.startsWith(BiometricCommands.ENROLLMENT)).pop()
    if (last === undefined) return undefined
    const state = last.slice(BiometricCommands.ENROLLMENT.length).trim()
    return /^[+-]?\d+$/.test(state) ? Number(state) !== 0 : undefined
  },

  /** The per user entries of the `prints` array of `dumpsys fingerprint`. Empty when the dump has none (or an unknown shape). */
  parseFingerprintDump(text: string): FingerprintPrints[] {
    const re = /"id"\s*:\s*(\d+)\s*,\s*"count"\s*:\s*(\d+)\s*,\s*"accept"\s*:\s*(\d+)\s*,\s*"reject"\s*:\s*(\d+)/g
    return [...text.matchAll(re)].map((m) => ({ id: Number(m[1]), count: Number(m[2]), accept: Number(m[3]), reject: Number(m[4]) }))
  },

  /** Total enrolled templates; undefined when the dump had no `prints` entries at all (no fingerprint service). */
  enrolledCount(text: string): number | undefined {
    const prints = BiometricCommands.parseFingerprintDump(text)
    return prints.length > 0 ? prints.reduce((sum, p) => sum + p.count, 0) : undefined
  },
}

function spawn(xcrun: string, udid: string, ...args: string[]): string[] {
  return [xcrun, 'simctl', 'spawn', udid, 'notifyutil', ...args]
}

/** Outcome of one button: the exact [text] to show and whether it is an [error]. */
export interface BiometricResult {
  readonly text: string
  readonly error: boolean
}

const result = (text: string, error = false): BiometricResult => ({ text, error })

/** iOS simulator side (`simctl spawn notifyutil`). */
export class IosBiometrics {
  constructor(
    private readonly xcrun: string,
    private readonly udid: string,
    private readonly runner: CommandRunner,
  ) {}

  private async run(cmd: string[]): Promise<string> {
    const r = await this.runner.run(cmd, 15_000)
    if (!r.ok) throw new CommandFailedException((r.stderr.trim() || r.text.trim() || `exit code ${r.exitCode}`).slice(0, 300))
    return r.text
  }

  /** What this tab (or an earlier notifyutil call) set; not Simulator.app's own Features menu state. Undefined when unreadable. */
  async readEnrolled(): Promise<boolean | undefined> {
    try {
      return BiometricCommands.parseEnrollment(await this.run(BiometricCommands.iosReadEnrollment(this.xcrun, this.udid)))
    } catch {
      return undefined
    }
  }

  async enroll(): Promise<BiometricResult> {
    for (const c of BiometricCommands.iosEnroll(this.xcrun, this.udid)) await this.run(c)
    return result(`Posted ${BiometricCommands.ENROLLMENT} with state 1 (enrolled). Whether the OS accepted it shows in the simulator (Face ID / Touch ID becomes usable).`)
  }

  async unenroll(): Promise<BiometricResult> {
    for (const c of BiometricCommands.iosUnenroll(this.xcrun, this.udid)) await this.run(c)
    return result(`Posted ${BiometricCommands.ENROLLMENT} with state 0 (not enrolled).`)
  }

  async match(b: IosBiometry): Promise<BiometricResult> {
    await this.run(BiometricCommands.iosMatch(this.xcrun, this.udid, b))
    return result(
      `Posted ${IosBiometries.matchNotification(b)}. notifyutil exits 0 for any name, so this only means the notification was sent; an app sees it only while a ${IosBiometries.label(b)} prompt is showing.`,
    )
  }

  async noMatch(b: IosBiometry): Promise<BiometricResult> {
    await this.run(BiometricCommands.iosNoMatch(this.xcrun, this.udid, b))
    return result(`Posted ${IosBiometries.noMatchNotification(b)}. This only means the notification was sent; an app sees it only while a ${IosBiometries.label(b)} prompt is showing.`)
  }
}

/** Android emulator side (`adb emu finger`, `dumpsys fingerprint`). */
export class AndroidBiometrics {
  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly runner: CommandRunner,
  ) {}

  private async emu(cmd: string[]): Promise<EmuReply> {
    const r = await this.runner.run(cmd, 15_000)
    const out = r.text + '\n' + r.stderr
    // adb itself fails (no device, console auth) with a non zero exit and no OK/KO line.
    const reply = BiometricCommands.parseEmuReply(out)
    if (!reply) throw new CommandFailedException((lines(out.trim()).find((l) => l.trim() !== '') ?? `No reply from adb (exit code ${r.exitCode})`).slice(0, 300))
    return reply
  }

  async touch(id: number): Promise<BiometricResult> {
    const r = await this.emu(BiometricCommands.androidTouch(this.adb, this.serial, id))
    return r.kind === 'Ok'
      ? result(`Console replied OK: finger ${id} touched the sensor. OK does not mean authentication succeeded: it is also the reply when no fingerprint is enrolled, and it carries no match information.`)
      : result(`Console replied KO: ${r.reason}`, true)
  }

  async lift(): Promise<BiometricResult> {
    const r = await this.emu(BiometricCommands.androidLift(this.adb, this.serial))
    return r.kind === 'Ok' ? result('Console replied OK: finger lifted.') : result(`Console replied KO: ${r.reason}`, true)
  }

  /** Raw `dumpsys fingerprint` entries; throws with the tool's text when the command fails. */
  async prints(): Promise<FingerprintPrints[]> {
    const r = await this.runner.run(BiometricCommands.androidDump(this.adb, this.serial), 15_000)
    if (!r.ok) throw new CommandFailedException((r.stderr.trim() ? r.stderr : r.text).trim().slice(0, 300))
    return BiometricCommands.parseFingerprintDump(r.text)
  }
}
