// ported-from: ui/NotificationsPanel.kt
// Host half of the Notifications tab: sends through simctl push / adb shell and keeps the history of sends in globalState
// (Kotlin setting `notificationHistory`). Validation and payload building are repeated here so the host never trusts the page.
import { Apps } from '../../core/apps/apps'
import {
  androidPost as makeAndroidPost,
  NotificationCommands,
  PayloadHistory,
  PostStyles,
  postStyles,
  type AndroidPost,
  type HistoryEntry,
  type IntentSpec,
  type NotificationResult,
} from '../../core/notifications/notifications'
import type { ToolContext, ToolHost } from './toolHost'

const HISTORY_KEY = 'mobileTestBench.notificationHistory'
const NOT_SUPPORTED: NotificationResult = { text: 'Not supported for this device', error: true }

const history = (ctx: ToolContext): HistoryEntry[] => PayloadHistory.load(ctx.extensionContext.globalState.get<string[]>(HISTORY_KEY, []))

/** Sends with [work]; a successful send with an [entry] is remembered. */
async function run(ctx: ToolContext, entry: HistoryEntry | undefined, work: () => Promise<NotificationResult>) {
  const result = await work()
  let entries = history(ctx)
  if (entry && !result.error) {
    entries = PayloadHistory.add(entries, entry)
    await ctx.extensionContext.globalState.update(HISTORY_KEY, PayloadHistory.save(entries))
  }
  return { result, history: entries }
}

function postFrom(raw: Record<string, unknown>): AndroidPost {
  const style = postStyles().find((s) => s.name === raw.style) ?? PostStyles.PLAIN
  return makeAndroidPost({
    title: String(raw.title ?? ''),
    text: String(raw.text ?? ''),
    style,
    tag: String(raw.tag ?? ''),
    lines: (raw.lines as string[]) ?? [],
    conversation: String(raw.conversation ?? ''),
    messages: (raw.messages as string[]) ?? [],
  })
}

export const notificationsHost: ToolHost = {
  id: 'notifications',
  title: 'Notifications',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    const entry = p.entry as HistoryEntry | undefined
    switch (method) {
      case 'history':
        return history(ctx)
      case 'apps': {
        // iOS: the installed bundle ids and the foreground one, for the bundle id field.
        const installed = await ctx.services
          .mobilecliData(ctx.device, ['apps', 'list'])
          .then((d) => Apps.parseList(d).map((a) => a.id).sort(), () => [] as string[])
        const foreground = await ctx.services.mobilecliData(ctx.device, ['apps', 'foreground']).then((d) => Apps.parseForeground(d)?.id, () => undefined)
        return { installed, foreground }
      }
      case 'sendIos': {
        const bundle = String(p.bundle)
        if (!NotificationCommands.validBundleId(bundle)) throw new Error('Not a valid bundle id')
        return run(ctx, entry, async () => (await ctx.services.iosNotifications(ctx.device)?.push(bundle, String(p.payload))) ?? NOT_SUPPORTED)
      }
      case 'sendPost': {
        const post = postFrom(p.post as Record<string, unknown>)
        const problem = NotificationCommands.postProblem(post)
        if (problem) return { result: { text: problem, error: true }, history: history(ctx) }
        return run(ctx, entry, async () => (await ctx.services.androidNotifications(ctx.device)?.post(post)) ?? NOT_SUPPORTED)
      }
      case 'sendClear':
        return run(ctx, undefined, async () => (await ctx.services.androidNotifications(ctx.device)?.clearShell()) ?? NOT_SUPPORTED)
      case 'sendBroadcast': {
        const intent = p.intent as IntentSpec
        const problem = NotificationCommands.broadcastProblem(intent)
        if (problem) return { result: { text: problem, error: true }, history: history(ctx) }
        return run(ctx, entry, async () => (await ctx.services.androidNotifications(ctx.device)?.broadcast(intent)) ?? NOT_SUPPORTED)
      }
      default:
        throw new Error(`Notifications: unknown method ${method}`)
    }
  },
}
