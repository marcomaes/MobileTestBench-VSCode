// ported-from: test:core/HierarchySnapshotsTest.kt
import { describe, expect, it } from 'vitest'
import { UiNode } from '../../src/core/inspector/uiNode'
import { HierarchySnapshots } from '../../src/core/recording/hierarchySnapshots'

const node = (label: string): UiNode => new UiNode('IOS', 'XCUIElementTypeApplication', { label }, undefined)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const attr = (n: UiNode, k: string): string | undefined => n.attributes[k]

describe('HierarchySnapshotsTest', () => {
  it('a snapshot is ready without waiting for the tap', async () => {
    let calls = 0
    const snapshots = new HierarchySnapshots(async () => node(`v${++calls}`), 10, 1000)
    try {
      snapshots.start()
      await sleep(150)
      const started = performance.now()
      const root = (await snapshots.awaitFresh(2000, 2000)).root
      expect(performance.now() - started).toBeLessThan(50)
      expect(attr(root, 'label')).toBe('v1')
    } finally {
      snapshots.close()
    }
  })

  it('after an input only a newer snapshot is returned', async () => {
    let screen = 1
    const snapshots = new HierarchySnapshots(async () => node(`screen${screen}`), 30, 1000)
    try {
      snapshots.start()
      expect(attr((await snapshots.awaitFresh(2000, 2000)).root, 'label')).toBe('screen1')
      screen = 2 // the tap changed the screen
      snapshots.inputDone()
      expect(attr((await snapshots.awaitFresh(2000, 2000)).root, 'label')).toBe('screen2')
    } finally {
      snapshots.close()
    }
  })

  it('the screen is captured again while idle', async () => {
    let calls = 0
    const snapshots = new HierarchySnapshots(async () => node(`v${++calls}`), 5, 40)
    try {
      snapshots.start()
      await sleep(300)
      expect(calls).toBeGreaterThanOrEqual(3)
    } finally {
      snapshots.close()
    }
  })

  it('a failing capture is retried and its error reported on timeout', async () => {
    let calls = 0
    const retried = new HierarchySnapshots(
      async () => {
        if (++calls < 3) throw new Error('no XML content')
        return node('ok')
      },
      5,
      1000,
      20,
    )
    try {
      retried.start()
      expect(attr((await retried.awaitFresh(2000, 2000)).root, 'label')).toBe('ok')
    } finally {
      retried.close()
    }
    const failing = new HierarchySnapshots(
      async () => {
        throw new Error('device offline')
      },
      5,
      1000,
      20,
    )
    try {
      failing.start()
      await expect(failing.awaitFresh(100, 150)).rejects.toThrow('device offline')
    } finally {
      failing.close()
    }
  })

  it('closing wakes a waiting tap', async () => {
    const snapshots = new HierarchySnapshots(async () => {
      await sleep(1500)
      return node('late')
    }, 5)
    snapshots.start()
    setTimeout(() => snapshots.close(), 100)
    const started = performance.now()
    await expect(snapshots.awaitFresh(5000, 5000)).rejects.toThrow('Recording stopped')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('a slow capture gives a stale snapshot instead of blocking the tap', async () => {
    let screen = 1
    let slow = false
    const snapshots = new HierarchySnapshots(
      async () => {
        const label = `screen${screen}`
        if (slow) await sleep(1500)
        return node(label)
      },
      10,
      1000,
    )
    try {
      snapshots.start()
      expect(attr((await snapshots.awaitFresh(2000, 2000)).root, 'label')).toBe('screen1')
      slow = true
      screen = 2
      snapshots.inputDone()
      const started = performance.now()
      const captured = await snapshots.awaitFresh(200, 2000)
      expect(performance.now() - started).toBeLessThan(800)
      expect(attr(captured.root, 'label')).toBe('screen1')
      expect(captured.fresh).toBe(false)
    } finally {
      snapshots.close()
    }
  })

  it('with no snapshot at all the tap keeps waiting and then reports the capture error', async () => {
    const snapshots = new HierarchySnapshots(
      async () => {
        throw new Error('no XML content')
      },
      5,
      1000,
      20,
    )
    try {
      snapshots.start()
      await expect(snapshots.awaitFresh(50, 200)).rejects.toThrow('no XML content')
    } finally {
      snapshots.close()
    }
  })
})
