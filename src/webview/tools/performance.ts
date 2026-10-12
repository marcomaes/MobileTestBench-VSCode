// ported-from: ui/PerformancePanel.kt
import { Stats, type PerfPoint } from '../../core/perf/perfModel'
import { PerfChart, perfChartCss, type ChartSeries } from '../perfChart'
import type { ToolApi, ToolView } from '../toolApi'
import { button, h, input, messageLine, select, table } from '../ui'

interface RunDto {
  index: number
  kind: string
  millis: number | undefined
  note: string
}
interface HistoryDto {
  time: string
  kind: string
  millis: number
  app: string
  device: string
}
interface State {
  platform: 'ANDROID' | 'IOS'
  supported: boolean
  idleStatus: string
  windows: number[]
  window: number
  runs: number
  kind: 'COLD' | 'WARM'
  foreground: string
  points: PerfPoint[]
  sampling: boolean
  status: { text: string; error: boolean }
  measuring: boolean
  progress: string
  runList: RunDto[]
  summary: string
  history: HistoryDto[]
}

const memorySeries: ChartSeries[] = [
  { name: 'PSS', colorVar: '--vscode-charts-blue', fallback: '#6C9BFF', value: (p) => p.memoryMb },
  { name: 'RSS', colorVar: '--vscode-charts-yellow', fallback: '#D9B84A', value: (p) => p.rssMb },
]
const cpuSeries: ChartSeries[] = [{ name: 'CPU', colorVar: '--vscode-charts-red', fallback: '#E55765', value: (p) => p.cpuPercent }]
const jankSeries: ChartSeries[] = [{ name: 'Janky', colorVar: '--vscode-charts-green', fallback: '#5FB865', value: (p) => p.jankPercent }]

const CSS =
  perfChartCss +
  `
  .mtb-perf { display: flex; flex-direction: column; gap: 4px; }
  .mtb-perf-body { display: flex; gap: 8px; flex-wrap: wrap; }
  .mtb-perf-charts { flex: 1 1 380px; min-width: 300px; }
  .mtb-perf-start { flex: 1 1 300px; min-width: 260px; }
  .mtb-perf-start .scroll { max-height: 160px; overflow: auto; }
  .mtb-perf-app { width: 300px; }
  .mtb-perf-history { font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 120px; overflow: auto; margin: 2px 0; }
`

let onShown: (() => void) | undefined

export const performanceView: ToolView = {
  id: 'performance',
  title: 'Performance',

  mount(root: HTMLElement, api: ToolApi) {
    if (!document.getElementById('mtb-perf-styles')) {
      const style = h('style', { id: 'mtb-perf-styles' })
      style.textContent = CSS
      document.head.append(style)
    }
    let st: State | undefined
    let points: PerfPoint[] = []
    let visible = false
    let loadedApps = false

    const status = messageLine()
    const appInput = input('', { class: 'mtb-input mtb-perf-app', list: 'mtb-perf-apps', title: 'Package name or bundle id; "Foreground app" follows the app in front' })
    const appList = h('datalist', { id: 'mtb-perf-apps' })
    const startBtn = button('Start', () => void startSampling())
    const stopBtn = button('Stop', () => void api.request('stop'))
    const clearBtn = button('Clear', () => void api.request('clear'))
    const saveBtn = button('Save CSV...', async () => {
      const result = await api.request<string | undefined>('saveCsv')
      if (result) status.set(result)
    })
    const windowSel = select([], undefined, (v) => {
      void api.request('setWindow', { seconds: Number(v) })
      refreshCharts()
    })

    const memory = new PerfChart('Memory', ' MB', memorySeries)
    const cpu = new PerfChart('CPU, % of one core', ' %', cpuSeries)
    const frames = new PerfChart('Janky frames', ' %', jankSeries, 100.0)
    const framesNote = h('div', { class: 'mtb-muted', style: 'padding:8px;display:none' }, 'Frame stats are not available on iOS simulators (they need Instruments).')

    const kindSel = select([
      { value: 'COLD', label: 'Cold' },
      { value: 'WARM', label: 'Warm' },
    ])
    const runsInput = h('input', { class: 'mtb-input', type: 'number', min: 1, max: 10, value: 5, style: 'width:60px' })
    const measureBtn = button('Measure', () => {
      const runs = Math.min(10, Math.max(1, Number(runsInput.value) || 1))
      void api.request('measure', { app: appInput.value, kind: kindSel.value, runs })
    })
    const cancelBtn = button('Cancel', () => void api.request('cancelMeasure'))
    const progress = h('div', { class: 'mtb-muted' })
    const summary = h('div')
    const caption = h('div', { class: 'mtb-muted' })
    const runTable = h('div', { class: 'scroll' })
    const historyBox = h('div', { class: 'mtb-perf-history' })

    const supportedNow = (): boolean => st?.supported === true
    const updateEnabled = (): void => {
      const ok = supportedNow()
      const sampling = st?.sampling === true
      const measuring = st?.measuring === true
      startBtn.disabled = !ok || sampling
      stopBtn.disabled = !sampling
      saveBtn.disabled = points.length === 0
      measureBtn.disabled = !ok || measuring
      cancelBtn.disabled = !measuring
      kindSel.disabled = measuring
      runsInput.disabled = measuring
    }
    const setStatus = (s: { text: string; error: boolean }): void => {
      if (st) st.status = s
      if (s.error) status.error(s.text || ' ')
      else status.set(s.text || ' ')
    }
    const refreshCharts = (): void => {
      const window = Number(windowSel.value) || 60
      const android = st?.platform === 'ANDROID'
      memory.setData(points, window, st?.platform === 'IOS' ? 'footprint' : undefined)
      cpu.setData(points, window)
      frames.setData(points, window, android ? `fps now ${Stats.format(points[points.length - 1]?.fps, '')}; an idle app renders no frames` : undefined)
      updateEnabled()
    }
    const renderRuns = (): void => {
      runTable.replaceChildren(
        table(
          ['Run', 'Kind', 'Milliseconds', 'Note'],
          (st?.runList ?? []).map((r) => [r.index, r.kind, r.millis === undefined ? 'failed' : String(r.millis), r.note]),
        ),
      )
      summary.textContent = st?.summary || ' '
    }
    const renderHistory = (): void => {
      historyBox.replaceChildren(...(st?.history ?? []).map((e) => h('div', {}, `${e.time}  ${e.kind}  ${e.millis} ms  ${e.app}  (${e.device})`)))
    }
    const configure = (): void => {
      if (!st) return
      if (!st.sampling) setStatus({ text: st.idleStatus, error: false })
      frames.element.style.display = st.platform === 'IOS' ? 'none' : ''
      framesNote.style.display = st.platform === 'IOS' ? '' : 'none'
      caption.textContent =
        st.platform === 'ANDROID'
          ? 'Method: am start -W TotalTime with the launcher intent (includes system work). Emulator timings depend on host load. Cold: force-stop, 1.5 s, launch. Warm: Home, 2 s, launch.'
          : 'Method: simulator log, launch request to UIApplication active (includes about 0.4 s launch animation). Fallback: the duration of the launch call, which only times the spawn. Cold: terminate, launch. Warm: Home, launch.'
      updateEnabled()
    }

    const startSampling = async (): Promise<void> => {
      await api.request('start', { app: appInput.value })
    }

    const loadApps = async (): Promise<void> => {
      const ids = await api.request<string[] | undefined>('apps').catch(() => [] as string[])
      if (!ids) return
      loadedApps = true
      appList.replaceChildren(...[st?.foreground ?? 'Foreground app', ...ids].map((id) => h('option', { value: id })))
    }

    const load = async (): Promise<void> => {
      try {
        st = await api.request<State>('state')
      } catch (e) {
        status.error((e as Error).message)
        return
      }
      points = st.points
      if (!appInput.value) appInput.value = st.foreground
      windowSel.replaceChildren(...st.windows.map((w) => h('option', { value: String(w) }, `${w}s window`)))
      windowSel.value = String(st.window)
      kindSel.value = st.kind
      runsInput.value = String(st.runs)
      progress.textContent = st.progress || ' '
      setStatus(st.status)
      configure()
      renderRuns()
      renderHistory()
      refreshCharts()
    }

    api.on('sample', (d) => {
      const e = d as { point: PerfPoint; status: { text: string; error: boolean } }
      points.push(e.point)
      if (points.length > 600) points.shift()
      setStatus(e.status)
      refreshCharts()
    })
    api.on('status', (d) => setStatus(d as { text: string; error: boolean }))
    api.on('sampling', (d) => {
      if (st) st.sampling = (d as { sampling: boolean }).sampling
      updateEnabled()
    })
    api.on('cleared', () => {
      points = []
      refreshCharts()
    })
    api.on('runsCleared', () => {
      if (st) {
        st.runList = []
        st.summary = ''
      }
      renderRuns()
    })
    api.on('run', (d) => {
      const e = d as { run: RunDto; summary: string; history: HistoryDto[] }
      if (st) {
        st.runList.push(e.run)
        st.summary = e.summary
        st.history = e.history
      }
      renderRuns()
      renderHistory()
    })
    api.on('progress', (d) => {
      const e = d as { progress: string; measuring: boolean }
      if (st) {
        st.measuring = e.measuring
        st.progress = e.progress
      }
      progress.textContent = e.progress || ' '
      updateEnabled()
    })

    root.append(
      h(
        'div',
        { class: 'mtb-perf' },
        h('div', { class: 'mtb-row' }, h('span', {}, 'App'), appInput, appList, startBtn, stopBtn, clearBtn, saveBtn, windowSel),
        status,
        h(
          'div',
          { class: 'mtb-perf-body' },
          h('div', { class: 'mtb-perf-charts' }, memory.element, cpu.element, frames.element, framesNote),
          h(
            'div',
            { class: 'mtb-perf-start' },
            h('div', {}, h('b', {}, 'Measure app start'), ' (a cold start stops the app chosen above)'),
            h('div', { class: 'mtb-row' }, h('span', {}, 'Kind'), kindSel, h('span', {}, 'Runs'), runsInput, measureBtn, cancelBtn),
            progress,
            runTable,
            summary,
            h('div', {}, 'Last 20 measurements (this session)'),
            historyBox,
            caption,
          ),
        ),
      ),
    )
    refreshCharts()
    void load().then(() => {
      if (visible && !loadedApps) void loadApps()
    })

    // Kotlin shown(): load the app list; the sampling itself starts with the Start button.
    onShown = () => {
      visible = true
      void load()
      void loadApps()
    }
  },

  shown() {
    onShown?.()
  },

  hidden() {},
}
