// No Kotlin counterpart: the ToolHost objects are shared by every open device viewer, while the Kotlin panels are one instance per window.
import type { ToolContext } from './toolHost'

const stores = new WeakMap<object, Map<string, unknown>>()

/**
 * State of one tool for one device viewer. The viewer builds its ToolContext once and `session` is the same function in every
 * copy of it, so that function identifies the viewer.
 */
export function viewerState<T>(ctx: ToolContext, tool: string, create: () => T): T {
  let store = stores.get(ctx.session)
  if (!store) stores.set(ctx.session, (store = new Map()))
  if (!store.has(tool)) store.set(tool, create())
  return store.get(tool) as T
}
