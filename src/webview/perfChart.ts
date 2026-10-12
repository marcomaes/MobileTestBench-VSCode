// ported-from: ui/PerfChart.kt
// A line chart on a plain 2D canvas: a title row with current / min / avg / max readouts per series, the last `window` seconds,
// grid, axis labels, gaps where a value is missing and a hover crosshair. Colours come from the VS Code theme variables.
import { Stats, type PerfPoint } from '../core/perf/perfModel'
import { h } from './ui'

/** One line of a [PerfChart]. [colorVar] is a VS Code chart colour variable, [fallback] the Kotlin colour. */
export interface ChartSeries {
  readonly name: string
  readonly colorVar: string
  readonly fallback: string
  readonly value: (p: PerfPoint) => number | undefined
}

const css = (name: string, fallback: string): string => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback

export class PerfChart {
  readonly element: HTMLElement
  private readonly readout = h('div', { class: 'mtb-chart-readout' })
  private readonly canvas = h('canvas', { class: 'mtb-chart-canvas' })
  private visiblePoints: PerfPoint[] = []
  private windowSeconds = 60
  private tEnd = 0
  private hoverX = -1
  private note: string | undefined

  constructor(
    private readonly title: string,
    private readonly unit: string,
    private readonly series: ChartSeries[],
    private readonly fixedMax?: number,
    private readonly decimals = 1,
  ) {
    this.element = h('div', { class: 'mtb-chart' }, this.readout, this.canvas)
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.offsetX
      this.paint()
    })
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = -1
      this.paint()
    })
    new ResizeObserver(() => this.paint()).observe(this.canvas)
    this.renderReadout()
  }

  /** Shows [points] (oldest first); only the last [window] seconds are drawn and counted in the readouts. */
  setData(points: readonly PerfPoint[], window: number, extra?: string): void {
    this.windowSeconds = window
    this.tEnd = points.length ? points[points.length - 1].seconds : 0
    this.visiblePoints = points.filter((p) => p.seconds >= this.tEnd - window)
    this.note = extra
    this.renderReadout()
    this.paint()
  }

  private renderReadout(): void {
    const parts = this.series.map((s) => {
      const st = Stats.of(this.visiblePoints.map(s.value))
      const dot = h('span', { style: `color:${css(s.colorVar, s.fallback)}` }, '■ ')
      const text =
        st.count === 0
          ? `${s.name}: no data`
          : `${s.name}: now ${Stats.format(st.current, this.unit, this.decimals)} / min ${Stats.format(st.min, this.unit, this.decimals)} / ` +
            `avg ${Stats.format(st.avg, this.unit, this.decimals)} / max ${Stats.format(st.max, this.unit, this.decimals)}`
      return h('span', { class: 'mtb-chart-part' }, dot, text)
    })
    this.readout.replaceChildren(h('b', {}, this.title), ` (last ${this.windowSeconds}s) `, ...parts, ...(this.note ? [h('i', {}, this.note)] : []))
  }

  private niceMax(v: number): number {
    if (v <= 0) return 1
    const p = Math.pow(10, Math.floor(Math.log10(v)))
    const n = v / p
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
    return step * p
  }

  private paint(): void {
    const cssW = this.canvas.clientWidth
    const cssH = this.canvas.clientHeight
    if (cssW === 0 || cssH === 0) return
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr)
      this.canvas.height = Math.round(cssH * dpr)
    }
    const g = this.canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cssW, cssH)
    this.paintBody(g, cssW, cssH)
  }

  private paintBody(g: CanvasRenderingContext2D, width: number, height: number): void {
    const left = 46
    const right = 8
    const top = 6
    const bottom = 16
    const w = width - left - right
    const hh = height - top - bottom
    if (w <= 10 || hh <= 10) return
    const axis = css('--vscode-descriptionForeground', '#808080')
    const grid = css('--vscode-editorWidget-border', css('--vscode-panel-border', 'rgba(128,128,128,0.25)'))
    const fg = css('--vscode-foreground', '#cccccc')
    g.font = `10px ${css('--vscode-font-family', 'sans-serif')}`
    g.textBaseline = 'alphabetic'

    const all: number[] = []
    for (const s of this.series) for (const p of this.visiblePoints) {
      const v = s.value(p)
      if (v !== undefined) all.push(v)
    }
    const yMax = this.fixedMax ?? this.niceMax((all.length ? Math.max(...all) : 0) * 1.1)
    const tStart = this.tEnd - this.windowSeconds
    const x = (t: number): number => left + ((t - tStart) / this.windowSeconds) * w
    const y = (v: number): number => top + hh - Math.min(Math.max((v / yMax) * hh, 0), hh)

    g.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4
      const yy = Math.trunc(y(v)) + 0.5
      g.strokeStyle = grid
      g.beginPath()
      g.moveTo(left, yy)
      g.lineTo(left + w, yy)
      g.stroke()
      g.fillStyle = axis
      const label = Stats.format(v, '', yMax >= 10 ? 0 : 1)
      g.fillText(label, left - g.measureText(label).width - 4, yy + 4)
    }
    g.fillStyle = axis
    g.fillText(`-${this.windowSeconds}s`, left, height - 3)
    g.fillText('now', left + w - g.measureText('now').width, height - 3)
    g.fillText(this.unit.trim(), 2, top + 9)

    if (this.visiblePoints.length === 0) {
      g.fillText('No samples yet', left + 8, top + hh / 2)
      return
    }
    g.lineWidth = 1.5
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const s of this.series) {
      const color = css(s.colorVar, s.fallback)
      g.strokeStyle = color
      g.fillStyle = color
      let run: Array<[number, number]> = []
      const flush = (): void => {
        if (run.length === 1) {
          g.beginPath()
          g.arc(run[0][0], run[0][1], 2, 0, Math.PI * 2)
          g.fill()
        } else if (run.length > 1) {
          g.beginPath()
          run.forEach(([px, py], i) => (i === 0 ? g.moveTo(px, py) : g.lineTo(px, py)))
          g.stroke()
        }
        run = []
      }
      for (const p of this.visiblePoints) {
        const v = s.value(p)
        if (v === undefined) {
          flush()
          continue
        }
        run.push([x(p.seconds), y(v)])
      }
      flush()
    }

    if (this.hoverX >= left && this.hoverX <= left + w) {
      const t = tStart + ((this.hoverX - left) / w) * this.windowSeconds
      let near = this.visiblePoints[0]
      for (const p of this.visiblePoints) if (Math.abs(p.seconds - t) < Math.abs(near.seconds - t)) near = p
      const nx = Math.trunc(x(near.seconds))
      g.lineWidth = 1
      g.strokeStyle = axis
      g.beginPath()
      g.moveTo(nx + 0.5, top)
      g.lineTo(nx + 0.5, top + hh)
      g.stroke()
      const lines = [`${(this.tEnd - near.seconds).toFixed(0)}s ago`, ...this.series.map((s) => `${s.name}: ${Stats.format(s.value(near), this.unit, this.decimals)}`)]
      const lineH = 12
      const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 10
      const bh = lines.length * lineH + 6
      const bx = nx + bw + 8 > left + w ? nx - bw - 6 : nx + 6
      g.fillStyle = css('--vscode-editorHoverWidget-background', css('--vscode-editor-background', '#252526'))
      g.beginPath()
      g.roundRect(bx, top + 2, bw, bh, 6)
      g.fill()
      g.strokeStyle = css('--vscode-editorHoverWidget-border', axis)
      g.stroke()
      g.fillStyle = fg
      lines.forEach((l, i) => g.fillText(l, bx + 5, top + 2 + 3 + 9 + i * lineH))
    }
  }
}

/** The CSS of the chart, injected by the Performance tab. */
export const perfChartCss = `
  .mtb-chart { padding: 2px 6px; }
  .mtb-chart-readout { font-size: 12px; margin-bottom: 2px; }
  .mtb-chart-part { margin-right: 10px; }
  .mtb-chart-canvas { width: 100%; height: 90px; display: block; }
`
