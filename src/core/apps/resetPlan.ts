// ported-from: core/apps/ResetPlan.kt
import type { Device } from '../model'
import { Apps } from './apps'

/** The steps of "Reset state", in the order they run. */
export enum ResetStep {
  TERMINATE,
  CLEAR_DATA,
  RESET_PERMISSIONS,
  RELAUNCH,
}

export const RESET_STEPS: ResetStep[] = [ResetStep.TERMINATE, ResetStep.CLEAR_DATA, ResetStep.RESET_PERMISSIONS, ResetStep.RELAUNCH]

const LABELS: Record<ResetStep, string> = {
  [ResetStep.TERMINATE]: 'Terminate the app',
  [ResetStep.CLEAR_DATA]: 'Clear its data',
  [ResetStep.RESET_PERMISSIONS]: 'Reset its permissions',
  [ResetStep.RELAUNCH]: 'Relaunch it afterwards',
}

export const resetStepLabel = (step: ResetStep): string => LABELS[step]

/** Which steps the user ticked. */
export class ResetChoices {
  constructor(
    readonly terminate = true,
    readonly clear = true,
    readonly permissions = true,
    readonly relaunch = true,
  ) {}

  wants(step: ResetStep): boolean {
    switch (step) {
      case ResetStep.TERMINATE:
        return this.terminate
      case ResetStep.CLEAR_DATA:
        return this.clear
      case ResetStep.RESET_PERMISSIONS:
        return this.permissions
      case ResetStep.RELAUNCH:
        return this.relaunch
    }
  }
}

/** One planned step. When [applies] is false the step is shown with [note] and not run. */
export interface PlannedStep {
  step: ResetStep
  applies: boolean
  note?: string
}

/** Pure planning of "Reset state": which steps apply to a device and in which order. */
export const ResetPlan = {
  /** Ticked steps only, always in the order terminate, clear, permissions, relaunch. Unsupported ticked steps are kept with a note. */
  plan(device: Device, choices: ResetChoices): PlannedStep[] {
    return RESET_STEPS.filter((s) => choices.wants(s)).map((step): PlannedStep => {
      if (step === ResetStep.CLEAR_DATA && !Apps.canClearData(device)) return { step, applies: false, note: 'skipped: not available on a real iPhone' }
      if (step === ResetStep.RESET_PERMISSIONS && !ResetPlan.canResetPermissions(device)) return { step, applies: false, note: 'skipped: not available on a real iPhone' }
      return { step, applies: true }
    })
  },

  /** Android (adb) and iOS simulators (simctl, macOS only; the runner checks that) can reset permissions; a real iPhone cannot. */
  canResetPermissions: (device: Device): boolean => device.platform === 'ANDROID' || device.kind === 'SIMULATOR',

  /** One line for a step row: first non-blank line of [text], trimmed. */
  oneLine(text: string): string {
    return text.split(/\r\n|\n|\r/).find((l) => l.trim().length > 0)?.trim() ?? 'failed'
  },
}
