// ported-from: test:core/ResetPlanTest.kt
import { describe, expect, it } from 'vitest'
import { ResetChoices, ResetPlan, ResetStep } from '../../src/core/apps/resetPlan'
import { makeDevice } from '../../src/core/model'

const android = makeDevice({ id: 'emulator-5554', name: 'Pixel', platform: 'ANDROID', kind: 'EMULATOR' })
const sim = makeDevice({ id: 'F236', name: 'iPhone', platform: 'IOS', kind: 'SIMULATOR' })
const phone = makeDevice({ id: '0000-1', name: 'iPhone', platform: 'IOS', kind: 'PHYSICAL' })
const all = [ResetStep.TERMINATE, ResetStep.CLEAR_DATA, ResetStep.RESET_PERMISSIONS, ResetStep.RELAUNCH]

describe('ResetPlanTest', () => {
  it('android and simulator keep all four steps in order', () => {
    for (const d of [android, sim]) {
      const plan = ResetPlan.plan(d, new ResetChoices())
      expect(plan.map((p) => p.step)).toEqual(all)
      expect(plan.every((p) => p.applies && p.note === undefined)).toBe(true)
    }
  })

  it('unticked steps are removed', () => {
    const plan = ResetPlan.plan(android, new ResetChoices(false, true, false, true))
    expect(plan.map((p) => p.step)).toEqual([ResetStep.CLEAR_DATA, ResetStep.RELAUNCH])
    expect(ResetPlan.plan(android, new ResetChoices(false, false, false, false))).toEqual([])
  })

  it('physical iPhone skips clear and permissions with notes', () => {
    const plan = ResetPlan.plan(phone, new ResetChoices())
    expect(plan.map((p) => p.step)).toEqual(all)
    expect(plan.find((p) => p.step === ResetStep.TERMINATE)!.applies).toBe(true)
    expect(plan.find((p) => p.step === ResetStep.RELAUNCH)!.applies).toBe(true)
    for (const s of [ResetStep.CLEAR_DATA, ResetStep.RESET_PERMISSIONS]) {
      const p = plan.find((x) => x.step === s)!
      expect(p.applies).toBe(false)
      expect(p.note).toBeDefined()
    }
    expect(plan.find((p) => p.step === ResetStep.TERMINATE)!.note).toBeUndefined()
  })

  it('oneLine keeps the first non blank line', () => {
    expect(ResetPlan.oneLine('\nfailed to clear: exit status 1\nOutput: Failed\n')).toBe('failed to clear: exit status 1')
    expect(ResetPlan.oneLine('  ')).toBe('failed')
  })
})
