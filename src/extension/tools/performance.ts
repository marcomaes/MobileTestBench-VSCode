// ported-from: ui/PerformancePanel.kt
// Host half of the Performance tab: sampling once per second between shown() and hidden(), PSS on its own 5 s task, start time
// measurements and the CSV export. The webview half only draws; every number reaches it through events.
import * as os from 'node:os'
import * as vscode from 'vscode'
import type { Device } from '../../core/model'
import type { PerfBackend } from '../../core/perf/perfBackends'
import {
  PerfCsv,
  PerfSampler,
  RingSeries,
  StartHistory,
  StartKind,
  StartRunner,
  StartSummary,
  perfPoint,
  startKindLabel,
  type PerfPoint,
  type StartRun,
} from '../../core/perf/perfModel'
import type { ToolContext, ToolHost } from './toolHost'

/** `Foreground app` entry of the app combo. */
const FOREGROUND = 'Foreground app'
const WINDOWS = [60, 300, 600]
const PSS_EVERY_MS = 5000

const supported = (d: Device): boolean => d.platform === 'ANDROID' || d.kind === 'SIMULATOR'
const firstLine = (s: string | undefined, fallback: string): string => s?.split(/\r?\n/).find((l) => l.trim().length > 0) ?? fallback

interface State {
  ctx: ToolContext
  /** Bumped on every start, stop and device change: a sampling loop of an older run ends and its results are dropped. */
  sampleGen: number
  measureGen: number
  appListGen: number
  cancelMeasure: boolean
  measuring: boolean
  sampling: boolean
  visible: boolean
  status: { text: string; error: boolean }
  progress: string
  points: RingSeries<PerfPoint>
  history: StartHistory
  runs: StartRun[]
}

// One ToolHost serves every open viewer, so the state is kept per device object (the viewer hands out a fresh ToolContext per call).
const states = new WeakMap<Device, State>()

function stateOf(ctx: ToolContext): State {
  let st = states.get(ctx.device)
  if (!st) {
    st = {
      ctx,
      sampleGen: 0,
      measureGen: 0,
      appListGen: 0,
      cancelMeasure: false,
      measuring: false,
      sampling: false,
      visible: false,
      status: { text: '', error: false },
      progress: '',
      points: new RingSeries<PerfPoint>(600),
      history: new StartHistory(20),
      runs: [],
    }
    states.set(ctx.device, st)
  }
  st.ctx = ctx
  return st
}

function setStatus(st: State, text: string, error = false): void {
  st.status = { text, error }
  st.ctx.emit('status', st.status)
}

function idleStatus(d: Device): string {
  return !supported(d) ? 'Performance needs an Android device or an iOS simulator (not a physical iPhone)' : 'Press Start to sample once per second'
}

function stopSampling(st: State, message?: string): void {
  st.sampleGen++
  st.sampling = false
  if (message !== undefined) setStatus(st, message)
  st.ctx.emit('sampling', { sampling: false })
}

/** The foreground app id from `mobilecli apps foreground` data (`packageName`). */
function foregroundId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const v = (data as Record<string, unknown>).packageName
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function appIds(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  const ids = data.map((e) => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>).packageName : undefined)).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  return ids.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
}

/** The sampling loop: one reading per second, never two at once (a slow call just delays the next one). Ends when `sampleGen` moves on. */
async function sampleLoop(st: State, dev: Device, my: number, choice: string | undefined): Promise<void> {
  const backend = st.ctx.services.perf(dev)
  if (!backend) {
    if (my === st.sampleGen) stopSampling(st, 'No performance data for this device')
    return
  }
  const sampler = new PerfSampler()
  let pssBusy = false
  // The cached PSS with the app and pid it belongs to; a result for anything else is dropped.
  let pss: { app: string; pid: number; mb: number } | undefined
  let pssApp: string | undefined
  let lastPid: number | undefined
  let lastPssAt = -Infinity
  let app = choice
  let nextForeground = 0
  const t0 = performance.now()
  let next = t0
  while (my === st.sampleGen) {
    let text: string
    let error = false
    let point: PerfPoint
    const elapsed = (performance.now() - t0) / 1000
    try {
      if (choice === undefined && performance.now() >= nextForeground) {
        nextForeground = performance.now() + 5000
        app = foregroundId(await st.ctx.services.mobilecliData(dev, ['apps', 'foreground']))
      }
      const current = app
      if (current === undefined) {
        point = perfPoint(elapsed)
        text = 'No foreground app found'
      } else {
        if (current !== pssApp) {
          pss = undefined
          pssApp = current
          lastPssAt = -Infinity
          lastPid = undefined
        }
        const reading = await backend.sample(current)
        if (reading.pid === undefined) {
          pss = undefined
          lastPssAt = -Infinity
          text = `${current} is not running (still polling)`
        } else {
          if (lastPid !== undefined && lastPid !== reading.pid) {
            pss = undefined
            lastPssAt = -Infinity
          }
          const pid = reading.pid
          // The slow PSS call runs as its own task every 5 s and is skipped while the previous one is still running.
          const due = performance.now() - lastPssAt >= PSS_EVERY_MS
          if (backend.hasFrames && backend.pssMb && due && !pssBusy) {
            pssBusy = true
            lastPssAt = performance.now()
            void backend
              .pssMb(current)
              .then((mb) => {
                if (mb !== undefined) pss = { app: current, pid, mb }
              })
              .catch(() => {})
              .finally(() => {
                pssBusy = false
              })
          }
          text = `Sampling ${current} (pid ${reading.pid})` + (lastPid !== undefined && lastPid !== reading.pid ? ' - restarted' : '')
        }
        const held = pss && pss.app === current && pss.pid === reading.pid ? pss.mb : undefined
        point = sampler.point(reading, held, elapsed)
        if (reading.pid !== undefined && point.cpuPercent === undefined) text += ', waiting for the first CPU sample'
        lastPid = reading.pid
      }
    } catch (e) {
      point = perfPoint(elapsed)
      text = `Sampling failed: ${firstLine((e as Error).message, (e as Error).name)}`
      error = true
    }
    if (my !== st.sampleGen) return
    st.points.add(point)
    st.status = { text, error }
    st.ctx.emit('sample', { point, status: st.status })
    next += 1000
    const wait = next - performance.now()
    if (wait < 0) next = performance.now()
    else await new Promise((r) => setTimeout(r, wait))
  }
}

function startSampling(st: State, choice: string | undefined): void {
  const dev = st.ctx.device
  stopSampling(st)
  st.points.clear()
  const my = ++st.sampleGen
  st.sampling = true
  setStatus(st, 'Starting...')
  st.ctx.emit('sampling', { sampling: true })
  st.ctx.emit('cleared')
  void sampleLoop(st, dev, my, choice).catch((e) => {
    if (my === st.sampleGen) {
      stopSampling(st)
      setStatus(st, `Sampling failed: ${firstLine((e as Error).message, 'error')}`, true)
    }
  })
}

async function saveCsv(st: State): Promise<string | undefined> {
  const list = st.points.toList()
  if (list.length === 0) return undefined
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri
  const defaultUri = folder ? vscode.Uri.joinPath(folder, 'performance.csv') : vscode.Uri.file(`${os.homedir()}/performance.csv`)
  const target = await vscode.window.showSaveDialog({ defaultUri, filters: { CSV: ['csv'] }, title: 'Save Performance Samples' })
  if (!target) return undefined
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(PerfCsv.toCsv(list), 'utf8'))
  } catch (e) {
    const text = `Saving failed: ${(e as Error).message}`
    setStatus(st, text, true)
    return text
  }
  const name = target.path.slice(target.path.lastIndexOf('/') + 1)
  setStatus(st, `Saved ${list.length} samples to ${name}`)
  return name
}

async function startMeasure(st: State, app: string | undefined, kind: StartKind, runsWanted: number): Promise<void> {
  const dev = st.ctx.device
  if (app === undefined) {
    st.progress = 'Pick or type an app first: a start is measured for an explicit app, not the foreground one.'
    st.ctx.emit('progress', { progress: st.progress, measuring: false })
    return
  }
  const count = Math.min(10, Math.max(1, Math.trunc(runsWanted) || 1))
  const message =
    kind === 'COLD'
      ? `A cold start stops ${app} (force-stop / terminate) and starts it ${count} time(s). Continue?`
      : `A warm start sends ${app} to the background with the Home button and launches it again, ${count} time(s). Continue?`
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Measure')
  if (answer !== 'Measure') return
  await st.ctx.updateSetting('perfStartRuns', count)
  await st.ctx.updateSetting('perfStartKind', kind)
  const my = ++st.measureGen
  st.cancelMeasure = false
  st.runs = []
  st.measuring = true
  st.progress = 'Starting...'
  st.ctx.emit('runsCleared')
  st.ctx.emit('progress', { progress: st.progress, measuring: true })
  let done: StartRun[] | undefined
  let failure: string | undefined
  try {
    const backend: PerfBackend | undefined = st.ctx.services.perf(dev)
    if (!backend) throw new Error('No performance backend for this device')
    if (dev.platform === 'IOS' && kind === 'WARM' && !st.ctx.services.mobilecli()) throw new Error('A warm start on an iOS simulator needs mobilecli for the Home button')
    done = await StartRunner.run(
      backend,
      app,
      kind,
      count,
      () => st.cancelMeasure || my !== st.measureGen,
      (d, total) => {
        if (my === st.measureGen) st.ctx.emit('progress', { progress: `Run ${d + 1} of ${total} ...`, measuring: true })
      },
      (run) => {
        if (my !== st.measureGen) return
        st.runs.push(run)
        if (run.millis !== undefined) st.history.add({ app, device: dev.name, kind: run.kind, millis: run.millis, atMillis: Date.now() })
        st.ctx.emit('run', { run: runDto(run), summary: StartSummary.of(st.runs)?.text() ?? '', history: historyDto(st) })
      },
    )
  } catch (e) {
    failure = (e as Error).message
  }
  if (my !== st.measureGen) return
  st.measuring = false
  const last = done?.[done.length - 1]
  st.progress = failure !== undefined ? `Failed: ${failure}` : st.cancelMeasure ? `Cancelled after ${done?.length ?? 0} run(s)` : last?.millis === undefined ? `Stopped at the first failed run: ${last?.note}` : `Done: ${done!.length} run(s)`
  st.ctx.emit('progress', { progress: st.progress, measuring: false })
}

const runDto = (r: StartRun) => ({ index: r.index, kind: startKindLabel(r.kind), millis: r.millis, note: r.note })
const historyDto = (st: State) =>
  st.history.entries().map((e) => ({ time: new Date(e.atMillis).toLocaleTimeString([], { hour12: false }), kind: startKindLabel(e.kind), millis: e.millis, app: e.app, device: e.device }))

export const performanceHost: ToolHost = {
  id: 'performance',
  title: 'Performance',

  async handle(method, params, ctx) {
    const st = stateOf(ctx)
    const p = (params ?? {}) as Record<string, unknown>
    const dev = ctx.device
    switch (method) {
      case 'state': {
        const s = ctx.settings()
        return {
          platform: dev.platform,
          supported: supported(dev),
          idleStatus: idleStatus(dev),
          windows: WINDOWS,
          window: WINDOWS.includes(s.perfWindowSeconds) ? s.perfWindowSeconds : 60,
          runs: Math.min(10, Math.max(1, s.perfStartRuns)),
          kind: s.perfStartKind === 'WARM' ? 'WARM' : 'COLD',
          foreground: FOREGROUND,
          points: st.points.toList(),
          sampling: st.sampling,
          status: st.status.text ? st.status : { text: idleStatus(dev), error: false },
          measuring: st.measuring,
          progress: st.progress,
          runList: st.runs.map(runDto),
          summary: StartSummary.of(st.runs)?.text() ?? '',
          history: historyDto(st),
          memoryLabel: ctx.services.perf(dev)?.memoryLabel,
        }
      }
      case 'apps': {
        const my = ++st.appListGen
        let ids: string[] = []
        try {
          ids = appIds(await ctx.services.mobilecliData(dev, ['apps', 'list']))
        } catch {
          ids = []
        }
        return my === st.appListGen ? ids : undefined
      }
      case 'start':
        if (supported(dev)) startSampling(st, typeof p.app === 'string' && p.app.trim() !== '' && p.app.trim() !== FOREGROUND ? p.app.trim() : undefined)
        return undefined
      case 'stop':
        stopSampling(st, 'Stopped')
        return undefined
      case 'clear':
        st.points.clear()
        ctx.emit('cleared')
        return undefined
      case 'saveCsv':
        return saveCsv(st)
      case 'setWindow': {
        const seconds = Number(p.seconds)
        if (WINDOWS.includes(seconds)) await ctx.updateSetting('perfWindowSeconds', seconds)
        return undefined
      }
      case 'measure': {
        const kind: StartKind = p.kind === 'WARM' ? StartKind.WARM : StartKind.COLD
        const app = typeof p.app === 'string' && p.app.trim() !== '' && p.app.trim() !== FOREGROUND ? p.app.trim() : undefined
        // Not awaited: the modal confirmation and the runs report through events, the request returns at once.
        void startMeasure(st, app, kind, Number(p.runs)).catch((e) => {
          st.measuring = false
          st.ctx.emit('progress', { progress: `Failed: ${(e as Error).message}`, measuring: false })
        })
        return undefined
      }
      case 'cancelMeasure':
        st.cancelMeasure = true
        st.progress = 'Cancelling after the current run...'
        ctx.emit('progress', { progress: st.progress, measuring: st.measuring })
        return undefined
      default:
        throw new Error(`Performance: unknown method ${method}`)
    }
  },

  shown(ctx) {
    stateOf(ctx).visible = true
  },

  hidden(ctx) {
    const st = stateOf(ctx)
    st.visible = false
    // Sampling costs a device call per second: it only runs while the tab is visible.
    if (st.sampling) stopSampling(st, 'Stopped: the tab was hidden (the samples are kept)')
  },

  dispose(ctx) {
    const st = stateOf(ctx)
    stopSampling(st)
    st.measureGen++
    st.cancelMeasure = true
    states.delete(ctx.device)
  },
}
