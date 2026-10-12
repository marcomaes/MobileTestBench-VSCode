// ported-from: ui/LocationPanel.kt
// Webview half of the Location tab: a place list (presets, then saved places), latitude and longitude, set and clear.
import { LocationOverride, type Place } from '../../core/location/locationOverride'
import type { ToolApi, ToolView } from '../toolApi'
import { button, h, injectToolStyles, input, messageLine, row, select } from '../ui'

const describe = (p: Place) => `${p.name} (${LocationOverride.format(p.latitude)}, ${LocationOverride.format(p.longitude)})`

export const locationView: ToolView = {
  id: 'location',
  title: 'Location',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    let busy = false
    let updating = false
    let savedPlaces: Place[] = []
    const lat = input('', { size: 12 })
    const lon = input('', { size: 12 })
    const status = messageLine()
    const setButton = button('Set location', () => void setLocation())
    const clearButton = button('Clear override', () => void run('Clearing override...', 'clear', {}))
    const save = button('Save place...', () => void savePlace())
    const del = button('Delete place', () => void deletePlace())
    const combo = select([{ value: '', label: '(custom)' }])

    const places = (): Place[] => [...LocationOverride.PRESETS, ...savedPlaces]
    const selectedPlace = (): Place | undefined => places().find((p) => p.name === combo.value)

    /** Rebuilds the combo: presets, then saved places. */
    function reloadPlaces(select_?: string): void {
      updating = true
      combo.replaceChildren(h('option', { value: '' }, '(custom)'), ...places().map((p) => h('option', { value: p.name }, describe(p))))
      combo.value = select_ ?? ''
      updating = false
    }

    function fill(p: Place): void {
      updating = true
      lat.value = LocationOverride.format(p.latitude)
      lon.value = LocationOverride.format(p.longitude)
      updating = false
      updateButtons()
    }

    function changed(field: HTMLInputElement): void {
      if (updating) return
      // A pasted "lat, lon" is split over both fields.
      const pair = LocationOverride.parsePair(field.value)
      if (pair) {
        updating = true
        lat.value = pair[0]
        lon.value = pair[1]
        updating = false
        updateButtons()
        return
      }
      updating = true
      combo.value = ''
      updating = false
      updateButtons()
    }

    function updateButtons(): void {
      const latError = lat.value.trim() === '' ? undefined : LocationOverride.validateLatitude(lat.value)
      const lonError = lon.value.trim() === '' ? undefined : LocationOverride.validateLongitude(lon.value)
      lat.style.outline = latError ? '1px solid var(--vscode-inputValidation-errorBorder)' : ''
      lon.style.outline = lonError ? '1px solid var(--vscode-inputValidation-errorBorder)' : ''
      lat.title = latError ?? ''
      lon.title = lonError ?? ''
      const valid = LocationOverride.parse(lat.value, lon.value).type === 'Ok'
      setButton.disabled = !api.device || busy || !valid
      // Clear is idempotent in mobilecli, so it is always offered while connected.
      clearButton.disabled = !api.device || busy
      save.disabled = !valid
      const selected = selectedPlace()
      del.disabled = !selected || LocationOverride.isPreset(selected)
    }

    async function run(progress: string, method: string, params: unknown): Promise<void> {
      if (busy) return
      busy = true
      updateButtons()
      status.set(progress)
      try {
        status.set(await api.request<string>(method, params))
      } catch (e) {
        status.error((e as Error).message)
      }
      busy = false
      updateButtons()
    }

    async function setLocation(): Promise<void> {
      const p = LocationOverride.parse(lat.value, lon.value)
      if (p.type === 'Invalid') {
        status.error(p.reason)
        return
      }
      await run('Setting location...', 'set', { latitude: lat.value, longitude: lon.value })
    }

    async function savePlace(): Promise<void> {
      try {
        const r = await api.request<{ cancelled?: boolean; places?: Place[]; selected?: string }>('savePlace', { latitude: lat.value, longitude: lon.value })
        if (r.cancelled || !r.places) return
        savedPlaces = r.places
        reloadPlaces(r.selected)
        status.set(`Saved place ${r.selected}`)
      } catch (e) {
        status.error((e as Error).message)
      }
      updateButtons()
    }

    async function deletePlace(): Promise<void> {
      const selected = selectedPlace()
      if (!selected || LocationOverride.isPreset(selected)) return
      const r = await api.request<{ places: Place[]; deleted?: string }>('deletePlace', { name: selected.name }).catch(() => undefined)
      if (!r) return
      savedPlaces = r.places
      reloadPlaces()
      status.set(`Deleted place ${selected.name}`)
      updateButtons()
    }

    combo.addEventListener('change', () => {
      if (!updating) {
        const p = selectedPlace()
        if (p) fill(p)
      }
      updateButtons()
    })
    for (const f of [lat, lon]) {
      f.addEventListener('input', () => changed(f))
      f.addEventListener('keydown', (e) => e.key === 'Enter' && void setLocation())
    }

    root.append(
      row('Place:', combo),
      row('Latitude:', lat, 'Longitude:', lon),
      row(setButton, clearButton, save, del),
      status,
      h('div', { class: 'mtb-muted' }, 'The override is held by the mobilecli background process; apps need location permission to see it. Paste "lat, lon" into either field.'),
    )
    reloadPlaces()
    void api.request<Place[]>('places').then((p) => {
      savedPlaces = p
      reloadPlaces(combo.value)
    }, () => undefined)
    status.set(api.device ? '' : 'Not connected')
    updateButtons()
  },
}
