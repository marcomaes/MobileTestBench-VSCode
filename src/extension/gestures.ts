// ported-from: ui/DeviceViewerPanel.kt
// The region of DeviceViewerPanel that feeds the recorder: ScreenInputHandler (what the user did on the mirror), `record` and
// `recordPoint` (tie the gesture to the hierarchy of the screen the user saw). Pure: no vscode import, so it is unit tested.
import type { Captured } from '../core/recording/hierarchySnapshots'
import { ScriptRecorder } from '../core/recording/scriptRecorder'
import type { DeviceKey } from '../core/model'

/** What the user did on the mirror, reported by the viewer to the recorder before the input is sent to the device. */
export type Gesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'doubleTap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number; durationMs: number }
  | { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'dragWithHold'; fromX: number; fromY: number; toX: number; toY: number; holdMs: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: DeviceKey }

/** Typing and Backspace keep the layout, so the recorder's hierarchy stays valid (the Kotlin `changesScreen = false`). */
export const changesScreen = (g: Gesture): boolean => !(g.kind === 'text' || (g.kind === 'key' && g.key === 'DELETE'))

/** Called by the viewer on the input queue before the input is sent; the viewer waits for it, so recorded steps keep their order. */
export type GestureListener = (gesture: Gesture) => void | Promise<void>

const firstLines = (e: unknown): string | undefined =>
  (e instanceof Error ? e.message : undefined)
    ?.split(/\r\n|\r|\n/)
    .map((it) => it.trim())
    .filter((it) => it.length > 0)
    .join(' | ')

/**
 * Records [gesture] into [recorder]: a gesture at a point is tied to the element under the finger using [awaitSnapshot] (a hierarchy
 * from the background capture); without one it becomes a note. Keys other than Enter, Backspace, Home and Back are not recorded.
 */
export async function recordGesture(recorder: ScriptRecorder, gesture: Gesture, awaitSnapshot: () => Promise<Captured>): Promise<void> {
  const point = async (x: number, y: number, what: string, step: (root: Captured['root'], fresh: boolean) => void): Promise<void> => {
    let captured: Captured
    try {
      captured = await awaitSnapshot()
    } catch (e) {
      recorder.tapWithoutHierarchy(x, y, firstLines(e), what)
      return
    }
    step(captured.root, captured.fresh)
  }
  switch (gesture.kind) {
    case 'tap':
      return point(gesture.x, gesture.y, 'tap', (root, fresh) => recorder.tap(root, gesture.x, gesture.y, fresh))
    case 'longPress':
      return point(gesture.x, gesture.y, 'long press', (root, fresh) => recorder.longPress(root, gesture.x, gesture.y, gesture.durationMs, fresh))
    case 'doubleTap':
      return point(gesture.x, gesture.y, 'double tap', (root, fresh) => recorder.doubleTap(root, gesture.x, gesture.y, fresh))
    case 'swipe':
      return recorder.swipe(gesture.fromX, gesture.fromY, gesture.toX, gesture.toY)
    case 'dragWithHold':
      return recorder.dragWithHold(gesture.fromX, gesture.fromY, gesture.toX, gesture.toY, gesture.holdMs)
    case 'text':
      return recorder.type(gesture.text)
    case 'key':
      if (gesture.key === 'DELETE') return recorder.delete()
      if (gesture.key === 'ENTER' || gesture.key === 'HOME' || gesture.key === 'BACK') return recorder.key(gesture.key)
  }
}
