// ported-from: ui/LogPanel.kt
// ported-from: ui/StackFrameOpener.kt
// Host half of the Log tab: owns the log process (LogStream) and streams batches of entries to the webview between shown() and
// hidden(). Filtering, the list, highlighting and the pause buffer live in the webview half (the Kotlin panel does both in one class).
import * as vscode from 'vscode'
import { Apps } from '../../core/apps/apps'
import type { LogEntry } from '../../core/logs/logs'
import type { LogStream } from '../../core/logs/logStream'
import { StackFrames } from '../../core/logs/stackFrames'
import { StackFrameOpener } from './stackFrameOpener'
import type { ToolContext, ToolHost } from './toolHost'
import { viewerState } from './viewerState'

/** How many lines are kept (the same number as the webview list): the oldest go first. */
const MAX_ENTRIES = 20_000
const BATCH_MS = 100

interface LogState {
  stream?: LogStream
  buffer: LogEntry[]
  timer?: ReturnType<typeof setInterval>
  /** Bumped on every start and stop: a late end or entry of an older stream is dropped. */
  generation: number
  restartGeneration: number
}

const state = (ctx: ToolContext): LogState => viewerState<LogState>(ctx, 'logs', () => ({ buffer: [], generation: 0, restartGeneration: 0 }))

const dto = (e: LogEntry) => ({ time: e.time, level: e.level, tag: e.tag, pid: e.pid, message: e.message })
const firstLine = (s: string): string => s.split(/\r\n|\n|\r/)[0]
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function flush(s: LogState, ctx: ToolContext): void {
  if (s.buffer.length === 0) return
  const batch = s.buffer
  s.buffer = []
  ctx.emit('entries', batch.map(dto))
}

function stop(ctx: ToolContext): void {
  const s = state(ctx)
  s.generation++
  s.restartGeneration++
  if (s.timer) clearInterval(s.timer)
  s.timer = undefined
  s.stream?.close()
  s.stream = undefined
  s.buffer = []
}

/** Streams the log of the device (Kotlin `attach`). */
function start(ctx: ToolContext): void {
  const s = state(ctx)
  if (s.stream) return
  const device = ctx.device
  const generation = ++s.generation
  ctx.emit('started')
  ctx.emit('state', { text: `Starting the log of ${device.name}...` })
  let started: LogStream | undefined
  try {
    started = ctx.services.startLog(
      device,
      (entry) => {
        if (s.generation !== generation) return
        s.buffer.push(entry)
        if (s.buffer.length > MAX_ENTRIES * 2) s.buffer.shift()
      },
      (error) => {
        if (s.generation !== generation || !s.stream) return
        s.stream = undefined
        flush(s, ctx)
        ctx.emit('state', { text: 'The log stopped' + (error ? `: ${firstLine(error)}` : '') })
      },
    )
  } catch (e) {
    ctx.emit('state', { text: `Could not start the log: ${firstLine(message(e))}` })
    return
  }
  if (!started) {
    ctx.emit('state', { text: device.platform === 'IOS' ? 'No log is available for a physical iPhone (it needs mobilecli)' : 'No log source for this device' })
    return
  }
  s.stream = started
  s.timer = setInterval(() => flush(s, ctx), BATCH_MS)
  const note = ctx.services.logSourceNote(device)
  ctx.emit('state', { text: `Streaming the log of ${device.name}` + (note ? ` ${note}` : '') })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const logsHost: ToolHost = {
  id: 'logs',
  title: 'Log',

  shown: start,
  hidden: stop,
  dispose: stop,

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'pids': {
        // Android: the process ids of an app (a failed lookup counts as "not running").
        try {
          return [...(await ctx.services.androidPids(ctx.device, String(p.name)))]
        } catch {
          return []
        }
      }
      case 'restart': {
        // Terminates and relaunches the app and looks up its new process ids (every 250 ms for up to 5 s on Android).
        const name = String(p.app).trim()
        const s = state(ctx)
        const generation = ++s.restartGeneration
        // A terminate that fails (not running, simctl status 3) is not fatal: the launch is what counts.
        await ctx.services.mobilecliCall(ctx.device, Apps.terminateArgs(name)).catch(() => undefined)
        const error = await ctx.services.mobilecliCall(ctx.device, Apps.launchArgs(ctx.device, name)).then(
          () => undefined,
          (e) => Apps.friendlyError(firstLine(message(e))),
        )
        let pids: string[] = []
        if (!error && ctx.device.platform === 'ANDROID') {
          for (let i = 0; i < 20 && pids.length === 0 && s.restartGeneration === generation; i++) {
            pids = await ctx.services.androidPids(ctx.device, name).then((x) => [...x], () => [])
            if (pids.length === 0) await sleep(250)
          }
        }
        return { error, pids, stale: s.restartGeneration !== generation }
      }
      case 'open': {
        // Opens the source of the first stack trace line of a message.
        const frame = StackFrames.extractFromMessage(String(p.message))
        if (!frame) return 'No stack trace line such as at com.example.Foo.bar(Foo.java:12) in this row'
        return StackFrameOpener.open(frame)
      }
      case 'save': {
        const name = `${ctx.device.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'device'}.log`
        const defaultUri = vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name) : vscode.Uri.file(name)
        const target = await vscode.window.showSaveDialog({ defaultUri, filters: { 'Log files': ['log', 'txt'] }, title: 'Save Log' })
        if (!target) return ''
        const text = String(p.text)
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'))
          return `Saved ${Number(p.count)} lines to ${target.fsPath}`
        } catch (e) {
          return `Could not save the log: ${message(e)}`
        }
      }
      default:
        throw new Error(`Log: unknown method ${method}`)
    }
  },
}
