// ported-from: ui/AppsPanel.kt
// ported-from: ui/ResetStateDialog.kt
// ported-from: ui/PermissionsDialog.kt
// Webview half of the Apps tab. Reset state and Permissions are inline forms below the list (the Kotlin dialogs).
import { Apps, type AppInfo } from '../../core/apps/apps'
import { RESET_STEPS, ResetChoices, ResetPlan, ResetStep, resetStepLabel } from '../../core/apps/resetPlan'
import { makeDevice, type Device, type DeviceKind } from '../../core/model'
import { IosPrivacyActions, iosPrivacyServices, RuntimePermission, type IosPrivacyAction } from '../../core/permissions/permissions'
import type { DeviceInfoDto } from '../../protocol'
import type { ToolApi, ToolView } from '../toolApi'
import { button, checkbox, copyText, h, injectToolStyles, input, messageLine, row, table } from '../ui'

interface FgDto {
  id: string
  name: string
  activity?: string
  isHome: boolean
}

interface ListResult {
  apps: AppInfo[]
  foreground: FgDto | null
  userPackages: string[] | null
  userPackagesFailed: boolean
  hideSystem: boolean
}

interface PermDto {
  name: string
  granted: boolean
  flags: string[]
}

interface ResultDto {
  text: string
  ok: boolean
}

const toDevice = (d: DeviceInfoDto): Device => makeDevice({ id: d.id, name: d.name, platform: d.platform, kind: d.kind as DeviceKind, osVersion: d.osVersion })

/** Set by mount: loads the list when the tab becomes visible and nothing was loaded yet (one webview page is one device viewer). */
let loadIfNeeded: (() => void) | undefined

export const appsView: ToolView = {
  id: 'apps',
  title: 'Apps',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    root.append(h('style', {}, '.mtb-apps tr.fg td { font-weight: 700; } .mtb-box { border: 1px solid var(--vscode-panel-border); padding: 6px; margin: 6px 0; } .mtb-apps-list { max-height: 260px; overflow: auto; }'))

    const device = (): Device | undefined => (api.device ? toDevice(api.device) : undefined)

    // ---- state
    let apps: AppInfo[] = []
    let shownApps: AppInfo[] = []
    let foreground: FgDto | null = null
    let userPackages: Set<string> | undefined
    let userPackagesFailed = false
    let hideSystemOn = true
    let loading = false
    let selectedId: string | undefined
    let generation = 0
    let delayed: ReturnType<typeof setTimeout> | undefined

    // ---- controls
    const filter = input('', { placeholder: 'Filter by name or id', size: 18 })
    const hideSystem = checkbox('Hide system apps', true, (v) => {
      hideSystemOn = v
      void api.request('setHideSystem', { value: v })
      applyFilter()
      if (!loading) setStatus(countText())
    })
    hideSystem.title = 'Android: apps not in pm list packages -3. iOS: bundle ids starting with com.apple.'
    const foregroundLabel = h('span', { class: 'mtb-muted' })
    const status = messageLine()
    const listBox = h('div', { class: 'mtb-apps-list' })
    const detail = h('div', {})

    const launch = button('Launch', () => launchSelected())
    const launchOptions = button('Launch with options...', () => showLaunchOptions())
    const terminate = button('Terminate', () => terminateSelected())
    const clear = button('Clear data', () => clearSelected())
    const resetState = button('Reset state...', () => showReset())
    const uninstall = button('Uninstall', () => uninstallSelected())
    const permissions = button('Permissions...', () => showPermissions())
    const copyId = button('Copy id', () => copySelected())
    const showLogButton = button('Show log of this app', () => showLogSelected())
    const install = button('Install...', () => installApp())

    const setStatus = (t: string) => status.set(t)
    const selected = (): AppInfo | undefined => shownApps.find((a) => a.id === selectedId)
    const message = (e: unknown) => Apps.friendlyError(e instanceof Error ? e.message : String(e))

    function updateButtons(): void {
      const dev = device()
      const has = dev !== undefined && selected() !== undefined
      launch.disabled = !has
      launchOptions.disabled = !has
      terminate.disabled = !has
      clear.disabled = !(has && Apps.canClearData(dev!))
      clear.title = dev && !Apps.canClearData(dev) ? 'Clearing data is not available on a real iPhone' : "Deletes the app's data and kills it; on Android also revokes its runtime permissions"
      resetState.disabled = !has
      uninstall.disabled = !has
      permissions.disabled = !has
      copyId.disabled = !has
      showLogButton.disabled = !has
      install.disabled = dev === undefined
    }

    function updateForegroundLabel(): void {
      const f = foreground
      foregroundLabel.textContent = !f ? '' : f.isHome ? 'Foreground: Home screen' : `Foreground: ${f.name} (${f.id})` + (f.activity ? ` / ${f.activity}` : '')
    }

    function countText(): string {
      const dev = device()
      if (!dev || !hideSystemOn) return `${apps.length} apps`
      if (dev.platform === 'ANDROID' && userPackagesFailed) return `${apps.length} apps, could not tell system apps apart`
      return `${apps.length} apps, ${apps.length - Apps.hideSystem(apps, dev, userPackages, true).length} system hidden`
    }

    function applyFilter(): void {
      const dev = device()
      const candidates = dev ? Apps.hideSystem(apps, dev, userPackages, hideSystemOn, selectedId) : apps
      shownApps = Apps.filter(candidates, filter.value)
      if (selectedId && !shownApps.some((a) => a.id === selectedId)) selectedId = undefined
      renderList()
      updateButtons()
    }

    function renderList(): void {
      const t = table(
        ['Name', 'Id', 'Version'],
        shownApps.map((a) => [a.name, a.id, a.version]),
        (i, tr) => {
          const a = shownApps[i]
          if (a.id === selectedId) tr.classList.add('sel')
          if (a.id === foreground?.id) tr.classList.add('fg')
          tr.addEventListener('click', () => {
            selectedId = a.id
            listBox.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'))
            tr.classList.add('sel')
            updateButtons()
          })
          tr.addEventListener('dblclick', () => launchSelected())
        },
      )
      t.classList.add('mtb-apps')
      listBox.replaceChildren(t)
    }

    /** Loads the app list and the foreground app. A [note] (the result of an action) stays visible in the status line. */
    async function refresh(note?: string): Promise<void> {
      if (!api.device) return
      const gen = ++generation
      loading = true
      setStatus(note === undefined ? 'Loading apps...' : `${note} (loading apps...)`)
      try {
        const r = await api.request<ListResult>('list')
        if (gen !== generation) return
        loading = false
        apps = r.apps
        userPackages = r.userPackages ? new Set(r.userPackages) : undefined
        userPackagesFailed = r.userPackagesFailed
        foreground = r.foreground
        hideSystemOn = r.hideSystem
        hideSystemBox().checked = hideSystemOn
        applyFilter()
        updateForegroundLabel()
        const count = countText()
        setStatus(note === undefined ? count : `${note} (${count})`)
      } catch (e) {
        if (gen !== generation) return
        loading = false
        status.error(note === undefined ? `Could not list apps: ${message(e)}` : `${note} (could not reload apps: ${message(e)})`)
      }
    }
    const hideSystemBox = (): HTMLInputElement => hideSystem.querySelector('input')!

    async function refreshForeground(): Promise<void> {
      try {
        foreground = await api.request<FgDto | null>('foreground')
      } catch {
        foreground = null
      }
      updateForegroundLabel()
      renderList()
    }

    /** Runs one host action, reports the result, then refreshes the foreground (and the list when [reloadList]). */
    async function run(label: string, method: string, params: unknown, reloadList: boolean): Promise<void> {
      setStatus(`${label}...`)
      try {
        const r = await api.request<{ cancelled?: boolean } | undefined>(method, params)
        if (r?.cancelled) {
          setStatus('')
          return
        }
        // The list is reloaded only after a success; the action's message stays in the status line.
        if (reloadList) void refresh(`${label}: done`)
        else setStatus(`${label}: done`)
      } catch (e) {
        status.error(`${label} failed: ${message(e)}`)
      }
      // Launch returns before the app is up, so the foreground is read after a short delay.
      if (delayed) clearTimeout(delayed)
      delayed = setTimeout(() => void refreshForeground(), 1200)
    }

    const launchSelected = () => {
      const a = selected()
      if (a) void run(`Launch ${a.name}`, 'launch', { id: a.id }, false)
    }
    const terminateSelected = () => {
      const a = selected()
      if (a) void run(`Terminate ${a.name}`, 'terminate', { id: a.id }, false)
    }
    const clearSelected = () => {
      const a = selected()
      if (a) void run(`Clear data of ${a.name}`, 'clear', { id: a.id, name: a.name }, false)
    }
    const uninstallSelected = () => {
      const a = selected()
      if (a) void run(`Uninstall ${a.name}`, 'uninstall', { id: a.id, name: a.name }, true)
    }
    const copySelected = () => {
      const a = selected()
      if (!a) return
      void copyText(a.id)
      setStatus(`Copied ${a.id}`)
    }
    const showLogSelected = () => {
      const a = selected()
      if (!a) return
      // Switch to the Log tab (mounting it when needed), then hand it the app: the Kotlin AppsPanel calls back into the LogPanel.
      document.querySelector<HTMLButtonElement>('#tabs button[data-id="logs"]')?.click()
      window.dispatchEvent(new CustomEvent('mtb:showLog', { detail: { app: a.id } }))
    }
    async function installApp(): Promise<void> {
      if (!device()) {
        setStatus('Connect a device first')
        return
      }
      setStatus('Choose a file to install...')
      try {
        const r = await api.request<{ cancelled?: boolean; name?: string }>('install')
        if (r.cancelled) {
          setStatus('')
          return
        }
        void refresh(`Install ${r.name}: done`)
      } catch (e) {
        status.error(message(e))
      }
    }

    // ---- inline forms
    function closeDetail(): void {
      detail.replaceChildren()
      permGeneration++
    }

    /** Asks for the optional locale (and, on Android, activity) first. */
    function showLaunchOptions(): void {
      const dev = device()
      const a = selected()
      if (!dev || !a) return
      const locale = input('', { placeholder: 'e.g. fr-FR,en-GB (optional)', size: 24 })
      const activity = input('', { placeholder: 'e.g. .MainActivity (optional)', size: 24 })
      const go = () => {
        closeDetail()
        void run(`Launch ${a.name}`, 'launch', { id: a.id, locale: locale.value, activity: activity.value }, false)
      }
      locale.addEventListener('keydown', (e) => e.key === 'Enter' && go())
      activity.addEventListener('keydown', (e) => e.key === 'Enter' && go())
      detail.replaceChildren(
        h(
          'div',
          { class: 'mtb-box' },
          h('b', {}, `Launch ${a.name}`),
          row('Locale:', locale),
          Apps.supportsActivity(dev) ? row('Activity:', activity) : '',
          row(button('Launch', go), button('Cancel', closeDetail)),
        ),
      )
      locale.focus()
    }

    // ---- Reset state
    async function showReset(): Promise<void> {
      const dev = device()
      const a = selected()
      if (!dev || !a) return
      closeDetail()
      const stored = await api.request<{ terminate: boolean; clear: boolean; permissions: boolean; relaunch: boolean }>('resetChoices').catch(() => ({ terminate: true, clear: true, permissions: true, relaunch: true }))
      const initial: Record<ResetStep, boolean> = {
        [ResetStep.TERMINATE]: stored.terminate,
        [ResetStep.CLEAR_DATA]: stored.clear,
        [ResetStep.RESET_PERMISSIONS]: stored.permissions,
        [ResetStep.RELAUNCH]: stored.relaunch,
      }
      const boxes = new Map<ResetStep, HTMLInputElement>()
      let started = false
      let finished = false
      const go = button('Reset', () => void doReset())
      const noClear = !Apps.canClearData(dev)
      const noPerm = !ResetPlan.canResetPermissions(dev)
      const rows = h('div', {})

      const checks = RESET_STEPS.map((step) => {
        const disabled = (step === ResetStep.CLEAR_DATA && noClear) || (step === ResetStep.RESET_PERMISSIONS && noPerm)
        const label = checkbox(resetStepLabel(step), disabled ? false : initial[step], () => showPlan())
        const box = label.querySelector('input')!
        if (disabled) {
          box.disabled = true
          label.title = 'Not available on a real iPhone'
        }
        boxes.set(step, box)
        return h('div', {}, label)
      })

      const choices = () => new ResetChoices(boxes.get(ResetStep.TERMINATE)!.checked, boxes.get(ResetStep.CLEAR_DATA)!.checked, boxes.get(ResetStep.RESET_PERMISSIONS)!.checked, boxes.get(ResetStep.RELAUNCH)!.checked)

      function showPlan(): void {
        const plan = ResetPlan.plan(dev!, choices())
        rows.replaceChildren(...(plan.length === 0 ? [h('div', {}, 'Nothing is ticked')] : plan.map((p) => h('div', {}, `${resetStepLabel(p.step)}: ${p.applies ? 'pending' : (p.note ?? 'skipped')}`))))
        go.disabled = started || plan.length === 0
      }

      async function doReset(): Promise<void> {
        if (finished) return closeDetail()
        if (started) return
        const plan = ResetPlan.plan(dev!, choices())
        if (plan.length === 0) return
        started = true
        go.disabled = true
        boxes.forEach((b) => (b.disabled = true))
        const unsubscribe = api.on('resetStep', (d) => {
          const { index, text } = d as { index: number; text: string }
          const el = rows.children[index]
          if (el) el.textContent = text
          else rows.append(h('div', {}, text))
        })
        rows.replaceChildren(...plan.map((p) => h('div', {}, `${resetStepLabel(p.step)}: ${p.applies ? 'pending' : (p.note ?? 'skipped')}`)))
        const c = choices()
        try {
          // Kotlin only stores the clear/permissions choice when its box was enabled: keep the stored value for a disabled one.
          const persist = { terminate: c.terminate, clear: noClear ? stored.clear : c.clear, permissions: noPerm ? stored.permissions : c.permissions, relaunch: c.relaunch }
          await api.request('resetRun', { app: a, choices: { terminate: c.terminate, clear: c.clear, permissions: c.permissions, relaunch: c.relaunch }, persist })
        } catch (e) {
          rows.append(h('div', { class: 'mtb-msg err' }, message(e)))
        }
        unsubscribe()
        finished = true
        go.textContent = 'Close'
        go.disabled = false
        void refreshForeground()
      }

      detail.replaceChildren(
        h(
          'div',
          { class: 'mtb-box' },
          h('b', {}, `Reset state of ${a.name}`),
          h('div', { class: 'mtb-muted' }, `${a.name} (${a.id}) on ${dev.name}`),
          ...checks,
          dev.platform === 'ANDROID' ? h('div', { class: 'mtb-muted' }, 'On Android, clearing data also kills the app and revokes its runtime permissions.') : '',
          h('b', {}, 'Steps'),
          rows,
          row(go, button('Cancel', closeDetail)),
        ),
      )
      showPlan()
    }

    // ---- Permissions
    let permGeneration = 0
    function showPermissions(): void {
      const dev = device()
      const a = selected()
      if (!dev || !a) return
      closeDetail()
      const generationAtOpen = ++permGeneration
      const android = dev.platform === 'ANDROID'
      // simctl only knows simulators; physical Android devices work through adb like emulators
      const unsupported = dev.platform === 'IOS' && dev.kind === 'PHYSICAL'
      const services = iosPrivacyServices()
      let set: { runtime: RuntimePermission[]; installTimeCount: number } | undefined
      let busy = false
      let selectedName: string | undefined
      let selectedService: string | undefined = services[0].name
      let gen = 0

      const note = h('div', { class: 'mtb-muted' })
      const log = h('div', { class: 'mtb-code' })
      const listEl = h('div', { class: 'mtb-apps-list' })
      const grant = button('Grant', () => (android ? act(true) : iosAction(IosPrivacyActions.GRANT)))
      const revoke = button('Revoke', () => (android ? act(false) : iosAction(IosPrivacyActions.REVOKE)))
      const reset = button('Reset', () => iosAction(IosPrivacyActions.RESET))
      const resetAll = button('Reset all', () => void resetAllAndroid(), { title: 'Revokes every runtime permission and clears its user-set and user-fixed flags (Android has no per-app system reset)' })
      const refreshButton = button('Refresh', () => void load())

      const current = (): RuntimePermission | undefined => set?.runtime.find((p) => p.name === selectedName)

      function updateButtons(): void {
        if (unsupported) {
          for (const b of [grant, revoke, reset, resetAll, refreshButton]) b.disabled = true
          return
        }
        const has = (android ? selectedName !== undefined : selectedService !== undefined) && !busy
        const p = current()
        grant.disabled = !has || (android && p?.granted !== false)
        revoke.disabled = !has || (android && p?.granted !== true)
        reset.disabled = !has
        resetAll.disabled = busy || !(set && set.runtime.length > 0)
        refreshButton.disabled = busy
      }

      function renderTable(): void {
        const rowsData = android
          ? (set?.runtime ?? []).map((p) => [p.shortName, p.granted ? 'Granted' : 'Denied', [...p.flags].join(' ').toLowerCase()])
          : services.map((s) => [`${s.label} (${s.simctl})`, 'Unknown', s.note ?? ''])
        const t = table(android ? ['Permission', 'State', 'Flags'] : ['Service', 'State', 'Note'], rowsData, (i, tr) => {
          const key = android ? set!.runtime[i].name : services[i].name
          if ((android ? selectedName : selectedService) === key) tr.classList.add('sel')
          tr.addEventListener('click', () => {
            if (android) selectedName = key
            else selectedService = key
            listEl.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'))
            tr.classList.add('sel')
            updateButtons()
          })
        })
        listEl.replaceChildren(t)
      }

      const append = (t: string) => {
        log.append(t + '\n')
        log.scrollTop = log.scrollHeight
      }

      /** Reads the app's permissions from the device. Late results (a newer load started) are dropped. */
      async function load(afterAction = false): Promise<void> {
        const my = ++gen
        busy = true
        if (!afterAction) note.textContent = 'Loading...'
        updateButtons()
        try {
          const r = await api.request<{ runtime: PermDto[]; installTimeCount: number }>('permRead', { id: a!.id })
          if (my !== gen || generationAtOpen !== permGeneration) return
          set = { runtime: r.runtime.map((p) => new RuntimePermission(p.name, p.granted, new Set(p.flags))), installTimeCount: r.installTimeCount }
          note.textContent =
            set.runtime.length === 0
              ? 'This app requests no runtime permissions'
              : `${set.runtime.length} runtime permissions. ${set.installTimeCount} install-time permissions (e.g. INTERNET) cannot be changed. A permission marked user_fixed will not prompt again after a revoke until Reset all clears it.`
        } catch (e) {
          if (my !== gen || generationAtOpen !== permGeneration) return
          set = undefined
          note.textContent = `Could not read permissions: ${(e as Error).message}`
        }
        busy = false
        renderTable()
        updateButtons()
      }

      /** Runs [work], appends each result to the log, then re-reads the device state (Android). */
      async function runActions(work: () => Promise<ResultDto[] | undefined>): Promise<void> {
        busy = true
        updateButtons()
        let results: ResultDto[] | undefined
        try {
          results = await work()
        } catch (e) {
          results = [{ text: `action: ${(e as Error).message}`, ok: false }]
        }
        results?.forEach((r) => append(r.text))
        busy = false
        if (android) await load(true)
        else updateButtons()
      }

      const act = (grantIt: boolean) => {
        const p = current()
        if (!p) return
        void runActions(async () => [await api.request<ResultDto>(grantIt ? 'permGrant' : 'permRevoke', { id: a.id, permission: p.name })])
      }
      const iosAction = (action: IosPrivacyAction) => {
        if (!selectedService) return
        void runActions(async () => {
          const r = await api.request<{ cancelled?: boolean; results?: ResultDto[] }>('permIos', { action: action.name, service: selectedService, id: a.id, name: a.name })
          return r.results
        })
      }
      async function resetAllAndroid(): Promise<void> {
        const perms = set?.runtime
        if (!perms) return
        void runActions(async () => {
          const r = await api.request<{ cancelled?: boolean; results?: ResultDto[] }>('permResetAll', { id: a!.id, name: a!.name, permissions: perms.map((p) => p.name) })
          return r.results
        })
      }

      detail.replaceChildren(
        h(
          'div',
          { class: 'mtb-box' },
          h('b', {}, `Permissions - ${a.name} (${a.id})`),
          note,
          row(grant, revoke, ...(android ? [resetAll, refreshButton] : [reset]), button('Close', closeDetail)),
          listEl,
          log,
        ),
      )
      if (unsupported) {
        note.textContent = 'Permissions can only be changed on iOS simulators and Android devices'
        updateButtons()
      } else if (android) void load()
      else {
        note.textContent = 'The current state cannot be read on iOS; simctl only sets it. Grant and revoke may terminate the app if it is running; reset did not in tests.'
        renderTable()
        updateButtons()
      }
    }

    // ---- layout
    filter.addEventListener('input', () => {
      applyFilter()
    })
    root.append(
      row(button('Refresh', () => void refresh()), filter, hideSystem, foregroundLabel),
      row(launch, launchOptions, terminate, clear, resetState, uninstall, permissions, copyId, showLogButton, install),
      listBox,
      status,
      detail,
    )
    updateButtons()
    setStatus(api.device ? 'Loading apps...' : 'Not connected')

    loadIfNeeded = () => {
      if (api.device && apps.length === 0 && !loading) void refresh()
    }
  },

  shown() {
    // Kotlin `shown`: load the list when the tab first becomes visible.
    loadIfNeeded?.()
  },

  deviceChanged() {
    // One viewer is one device: nothing to reset.
  },
}
