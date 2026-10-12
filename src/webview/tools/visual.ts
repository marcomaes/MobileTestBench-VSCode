// ported-from: ui/VisualPanel.kt
// Webview half of the Visual tab: baseline list, ignore areas, tolerance and the baseline | current | diff images. Saving, comparing and
// the files are requests to the host half (src/extension/tools/visual.ts); the host also draws the regions on the mirror.
import type { DeviceInfoDto } from '../../protocol'
import type { ToolApi, ToolView } from '../toolApi'
import { button, h, input, messageLine, table } from '../ui'

interface RectDto {
  x: number
  y: number
  width: number
  height: number
}
interface BaselineDto {
  name: string
  savedAt: number
  ignore: RectDto[]
}
interface OpResult {
  cancelled?: boolean
  name?: string
  message?: string
}
interface Outcome {
  message: string
  bad: boolean
  base: string | undefined
  current: string | undefined
  diff: string | undefined
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const CSS = `
  .mtb-visual { display: flex; flex-direction: column; gap: 4px; height: 100%; }
  .mtb-visual-top { display: flex; gap: 8px; flex-wrap: wrap; }
  .mtb-visual-lists { display: flex; gap: 8px; }
  .mtb-visual-lists .scroll { max-height: 100px; overflow: auto; min-width: 180px; }
  .mtb-visual-images { display: flex; gap: 6px; flex: 1 1 auto; min-height: 100px; overflow: auto; }
  .mtb-visual-images > div { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .mtb-visual-images img { max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--vscode-panel-border); align-self: flex-start; }
  .mtb-visual-ign input { width: 4em; }
`

export const visualView: ToolView = {
  id: 'visual',
  title: 'Visual',

  mount(root: HTMLElement, api: ToolApi) {
    if (!document.getElementById('mtb-visual-styles')) {
      const style = h('style', { id: 'mtb-visual-styles' })
      style.textContent = CSS
      document.head.append(style)
    }
    let device: DeviceInfoDto | undefined = api.device
    let visible = false
    /** Bumped on a device change: a late list or comparison result is dropped. */
    let gen = 0
    let baselines: BaselineDto[] = []
    let selected: string | undefined
    let ignoreIndex = -1
    let info: { tolerance: number; defaultName: string } | undefined

    const nameField = input('', { size: 16 })
    const save = button('Save baseline', () => void saveBaseline())
    const update = button('Update', () => void updateBaseline(), { title: "Replace the selected baseline's image with the current frame (keeps its ignore areas)" })
    const rename = button('Rename', () => void renameBaseline())
    const del = button('Delete', () => void deleteBaseline())
    const refresh = button('Refresh', () => void reloadList())
    const compare = button('Compare', () => void runCompare())
    const slider = h('input', { type: 'range', min: 0, max: 64, value: 8, title: 'Largest per-channel (R, G, B) difference that still counts as equal' })
    const toleranceLabel = h('span', {}, 'Tolerance 8')
    slider.addEventListener('input', () => (toleranceLabel.textContent = `Tolerance ${slider.value}`))
    slider.addEventListener('change', () => void api.request('setTolerance', { value: Number(slider.value) }).catch(() => undefined))
    const verdict = messageLine()
    const ignoreFields = ['x', 'y', 'w', 'h'].map((p) => input('', { placeholder: p, title: p }))
    const addIgnore = button('Add', () => void addIgnoreRegion())
    const removeIgnore = button('Remove', () => void removeIgnoreRegion())
    const baselineHost = h('div', { class: 'scroll' })
    const ignoreHost = h('div', { class: 'scroll' })
    const images = h('div', { class: 'mtb-visual-images' })

    root.append(
      h(
        'div',
        { class: 'mtb-visual' },
        h(
          'div',
          { class: 'mtb-visual-top' },
          h(
            'div',
            {},
            h('div', { class: 'mtb-row' }, 'Name:', nameField, save, update, rename, del, refresh),
            h('div', { class: 'mtb-row mtb-visual-ign' }, 'Ignore (device x, y, w, h):', ...ignoreFields, addIgnore, removeIgnore),
            h('div', { class: 'mtb-row' }, compare, toleranceLabel, slider),
          ),
          h('div', { class: 'mtb-visual-lists' }, baselineHost, ignoreHost),
        ),
        verdict,
        images,
      ),
    )

    const selectedBaseline = () => baselines.find((b) => b.name === selected)
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

    function updateButtons(): void {
      const connected = !!device
      const sel = !!selectedBaseline()
      save.disabled = !connected
      refresh.disabled = !connected
      update.disabled = !connected || !sel
      rename.disabled = !connected || !sel
      del.disabled = !connected || !sel
      compare.disabled = !connected || !sel
      addIgnore.disabled = !connected || !sel
      removeIgnore.disabled = !sel || ignoreIndex < 0
    }

    function say(text: string, error = false): void {
      if (error) verdict.error(text)
      else verdict.set(text)
    }

    function setImages(o?: Outcome): void {
      images.replaceChildren(
        ...(['Baseline', 'Current', 'Diff'] as const).map((label, i) => {
          const src = o ? [o.base, o.current, o.diff][i] : undefined
          return h('div', {}, h('div', {}, label), src ? h('img', { src, alt: label }) : false)
        }),
      )
    }

    function clearResult(text: string): void {
      void api.request('clearResult').catch(() => undefined)
      setImages()
      say(text)
    }

    function renderLists(): void {
      baselineHost.replaceChildren(
        table(
          ['Baseline', 'Saved'],
          baselines.map((b) => [b.name, b.savedAt > 0 ? stamp(b.savedAt) : '']),
          (i, tr) => {
            if (baselines[i].name === selected) tr.classList.add('sel')
            tr.addEventListener('click', () => {
              selected = baselines[i].name
              ignoreIndex = -1
              renderLists()
              updateButtons()
            })
          },
        ),
      )
      const rects = selectedBaseline()?.ignore ?? []
      ignoreHost.replaceChildren(
        table(
          ['Ignore areas'],
          rects.map((r) => [`x=${r.x} y=${r.y} w=${r.width} h=${r.height}`]),
          (i, tr) => {
            if (i === ignoreIndex) tr.classList.add('sel')
            tr.addEventListener('click', () => {
              ignoreIndex = i
              renderLists()
              updateButtons()
            })
          },
        ),
      )
    }

    async function reloadList(select?: string): Promise<void> {
      if (!device) return
      const my = gen
      const keep = select ?? selected
      try {
        const list = await api.request<BaselineDto[]>('list')
        if (my !== gen) return
        baselines = list
        selected = list.some((b) => b.name === keep) ? keep : undefined
        ignoreIndex = -1
        renderLists()
        updateButtons()
      } catch (e) {
        if (my === gen) say(`Could not read the baselines: ${msg(e)}`, true)
      }
    }

    /** Runs a host operation and reports its message or error unless the device changed meanwhile. */
    async function op(label: string, failure: string, work: () => Promise<OpResult>, after: (r: OpResult) => void | Promise<void>): Promise<void> {
      const my = gen
      if (label) say(label)
      try {
        const r = await work()
        if (my !== gen) return
        if (r.cancelled) {
          say(' ')
          return
        }
        await after(r)
      } catch (e) {
        if (my === gen) say(`${failure}: ${msg(e)}`, true)
      }
    }

    const saveBaseline = () =>
      op(
        'Saving...',
        'Could not save',
        () => api.request<OpResult>('save', { name: nameField.value }),
        async (r) => {
          say(r.message ?? '')
          if (r.name) nameField.value = r.name
          await reloadList(r.name)
        },
      )

    const updateBaseline = () => {
      const b = selectedBaseline()
      if (!b) return Promise.resolve()
      return op(
        'Updating...',
        'Could not update',
        () => api.request<OpResult>('update', { name: b.name }),
        async (r) => {
          clearResult(r.message ?? '')
          await reloadList(r.name)
        },
      )
    }

    const renameBaseline = () => {
      const b = selectedBaseline()
      if (!b) return Promise.resolve()
      return op(
        '',
        'Could not rename',
        () => api.request<OpResult>('rename', { name: b.name }),
        async (r) => {
          say(r.message ?? '')
          await reloadList(r.name)
        },
      )
    }

    const deleteBaseline = () => {
      const b = selectedBaseline()
      if (!b) return Promise.resolve()
      return op(
        '',
        'Could not delete',
        () => api.request<OpResult>('delete', { name: b.name }),
        async (r) => {
          clearResult(r.message ?? '')
          await reloadList()
        },
      )
    }

    async function ignoreChanged(work: () => Promise<BaselineDto>): Promise<void> {
      const my = gen
      try {
        const updated = await work()
        if (my !== gen) return
        baselines = baselines.map((b) => (b.name === updated.name ? updated : b))
        ignoreIndex = -1
        renderLists()
        updateButtons()
      } catch (e) {
        if (my === gen) say(`Could not save the ignore areas: ${msg(e)}`, true)
      }
    }

    async function addIgnoreRegion(): Promise<void> {
      const b = selectedBaseline()
      if (!b) return
      await ignoreChanged(() => api.request<BaselineDto>('addIgnore', { name: b.name, text: ignoreFields.map((f) => f.value.trim()).join(',') }))
      ignoreFields.forEach((f) => (f.value = ''))
    }

    async function removeIgnoreRegion(): Promise<void> {
      const b = selectedBaseline()
      if (!b || ignoreIndex < 0) return
      const index = ignoreIndex
      await ignoreChanged(() => api.request<BaselineDto>('removeIgnore', { name: b.name, index }))
    }

    async function runCompare(): Promise<void> {
      const b = selectedBaseline()
      if (!b) return
      const my = gen
      say('Comparing...')
      try {
        const o = await api.request<Outcome>('compare', { name: b.name, tolerance: Number(slider.value) })
        if (my !== gen) return
        setImages(o)
        say(o.message, o.bad)
      } catch (e) {
        if (my === gen) say(`Could not compare: ${msg(e)}`, true)
      }
    }

    async function activate(): Promise<void> {
      if (!device) return
      const my = gen
      try {
        info = await api.request<{ tolerance: number; defaultName: string }>('info')
        if (my !== gen) return
        slider.value = String(info.tolerance)
        toleranceLabel.textContent = `Tolerance ${slider.value}`
        if (!nameField.value.trim()) nameField.value = info.defaultName
      } catch {
        // the name field stays empty: the host names the baseline when saving
      }
      await reloadList()
    }

    setImages()
    renderLists()
    updateButtons()
    say(device ? ' ' : 'Not connected')

    activateHook = () => {
      visible = true
      void activate()
    }
    hiddenHook = () => {
      visible = false
    }
    deviceHook = (d) => {
      if (d && device && d.id === device.id) return
      device = d
      gen++
      baselines = []
      selected = undefined
      ignoreIndex = -1
      renderLists()
      setImages()
      say(d ? ' ' : 'Not connected')
      updateButtons()
      if (d && visible) void activate()
    }
    if (shownBeforeMount) activateHook()
  },

  deviceChanged(d) {
    deviceHook(d)
  },
  shown() {
    activateHook()
  },
  hidden() {
    hiddenHook()
  },
}

// ToolView callbacks reach the state of the mounted tab through these (one mounted tab per webview).
let shownBeforeMount = false
let activateHook: () => void = () => {
  shownBeforeMount = true
}
let hiddenHook: () => void = () => {}
let deviceHook: (d: DeviceInfoDto | undefined) => void = () => {}
