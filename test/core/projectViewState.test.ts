// ported-from: test:ui/ProjectViewStateTest.kt
import { describe, expect, it } from 'vitest'
import { ProjectLayout } from '../../src/core/project/projectLayout'
import { ProjectViewState, type MementoLike } from '../../src/extension/projectViewState'

class FakeMemento implements MementoLike {
  values = new Map<string, unknown>()
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)))
  }
}

describe('ProjectViewStateTest', () => {
  it('serviceLoadsAndSaves', async () => {
    const memento = new FakeMemento()
    const service = new ProjectViewState(memento)
    expect(service.layout().equals(new ProjectLayout())).toBe(true)
    const layout = new ProjectLayout({ lastDeviceId: 'emulator-5554', lastDeviceName: 'Pixel_9', inspectorOpen: true, toolsOpen: true, toolsTab: 'Apps', mirrorProportion: 0.4, toolsProportion: 0.6 })
    await service.save(layout)
    expect(service.layout().equals(layout)).toBe(true)

    // a state written to the workspace state comes back through layout(), invalid values fall back to the defaults
    await memento.update('mobileTestBench.projectView', { lastDeviceName: 'iPhone', mirrorProportion: 7 })
    expect(new ProjectViewState(memento).layout().lastDeviceName).toBe('iPhone')
    expect(new ProjectViewState(memento).layout().mirrorProportion).toBe(ProjectLayout.DEFAULT_MIRROR)
  })
})
