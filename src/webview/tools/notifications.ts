// ported-from: ui/NotificationsPanel.kt
// Webview half of the Notifications tab. iOS simulator: an APNs payload (form or raw JSON) through simctl push. Android: a notification
// posted by the shell package and an intent broadcast. The last 15 sends are remembered (history combo).
import {
  ApnsPayloads,
  apnsForm,
  historyEntry,
  historyLabel,
  NotificationCommands,
  postStyles,
  PostStyles,
  type ApnsPayload,
  type HistoryEntry,
  type NotificationResult,
} from '../../core/notifications/notifications'
import type { ToolApi, ToolView } from '../toolApi'
import { button, checkbox, field, h, injectToolStyles, input, select } from '../ui'

interface SendReply {
  result: NotificationResult
  history: HistoryEntry[]
}

// One webview page is one device viewer: `shown` reaches the mounted tab through this.
let onShown: (() => void) | undefined

const area = (rows: number): HTMLTextAreaElement => h('textarea', { class: 'mtb-input', rows, style: 'width:100%;box-sizing:border-box' })
const labelled = (label: string, control: HTMLElement): HTMLElement => h('div', { style: 'display:grid;grid-template-columns:200px 1fr;gap:6px;margin:3px 0;align-items:start' }, h('span', {}, label), control)
const note = (text: string): HTMLElement => h('div', { class: 'mtb-muted', style: 'margin:3px 0' }, text)

export const notificationsView: ToolView = {
  id: 'notifications',
  title: 'Notifications',

  mount(root: HTMLElement, api: ToolApi) {
    injectToolStyles()
    const platform = api.device?.platform
    const isIos = platform === 'IOS' && api.device?.kind === 'SIMULATOR'
    const isAndroid = platform === 'ANDROID'
    let busy = false
    let installed: string[] = []
    let loadingApps = false
    let entries: HistoryEntry[] = []
    let current: ApnsPayload = ApnsPayloads.build(apnsForm())

    // ---- common
    const result = h('div', { class: 'mtb-msg' })
    const historySelect = select([{ value: '', label: '(choose a remembered send)' }])
    function setResult(text: string, error = false): void {
      const first = (text.trim() ? text : ' ').split(/\r\n|\n|\r/)[0].slice(0, 300)
      result.className = error ? 'mtb-msg err' : 'mtb-msg'
      result.textContent = first
      result.title = text.split(/\r\n|\n|\r/).length > 1 || text.length > 80 ? text : ''
    }

    function fillHistory(): void {
      // Only entries for the current platform; with no usable device all of them.
      const shown = isAndroid ? entries.filter((e) => e.kind !== 'ios') : isIos ? entries.filter((e) => e.kind === 'ios') : entries
      historySelect.replaceChildren(h('option', { value: '' }, '(choose a remembered send)'), ...shown.map((e, i) => h('option', { value: String(i) }, historyLabel(e))))
      historySelect.dataset.count = String(shown.length)
      shownHistory = shown
    }
    let shownHistory: HistoryEntry[] = []

    // ---- iOS
    const bundle = input('', { size: 40, list: 'mtb-bundles' })
    const bundles = h('datalist', { id: 'mtb-bundles' })
    const bundleNote = h('div', { class: 'mtb-muted' })
    const rawMode = checkbox('Raw JSON', false, () => {
      if (rawBox.checked && raw.value.trim() === '') raw.value = current.pretty
      showMode()
      updatePreview()
    })
    const rawBox = rawMode.querySelector('input')!
    const fTitle = input('', { style: 'width:100%' })
    const fSubtitle = input('', { style: 'width:100%' })
    const fBody = input('', { style: 'width:100%' })
    const fBadge = input('', { size: 6 })
    const fSound = input('', { list: 'mtb-sounds', size: 16 })
    const sounds = h('datalist', { id: 'mtb-sounds' }, h('option', { value: 'default' }))
    const fCategory = input('', { style: 'width:100%' })
    const fCustom = area(3)
    const raw = area(10)
    const preview = h('pre', { class: 'mtb-code', style: 'max-height:200px;overflow:auto;margin:0' })
    const sizeLabel = h('div', {})
    const problemLabel = h('div', { style: 'color:var(--vscode-errorForeground)' })
    const iosSend = button('Send', () => void sendIos())
    const formRows: HTMLElement[] = [
      labelled('Title', fTitle),
      labelled('Subtitle', fSubtitle),
      labelled('Body', fBody),
      labelled('Badge', fBadge),
      labelled('Sound', h('span', {}, fSound, sounds)),
      labelled('Category', fCategory),
      labelled('Custom data (JSON object)', fCustom),
    ]
    const rawRows: HTMLElement[] = [labelled('Raw JSON', raw)]

    const form = () => apnsForm({ title: fTitle.value, subtitle: fSubtitle.value, body: fBody.value, badge: fBadge.value, sound: fSound.value, category: fCategory.value, customJson: fCustom.value })
    const bundleId = () => bundle.value.trim()

    function showMode(): void {
      const isRaw = rawBox.checked
      formRows.forEach((r) => (r.style.display = isRaw ? 'none' : ''))
      rawRows.forEach((r) => (r.style.display = isRaw ? '' : 'none'))
    }

    function updatePreview(): void {
      current = rawBox.checked ? ApnsPayloads.inspect(raw.value) : ApnsPayloads.build(form())
      preview.textContent = current.pretty
      sizeLabel.textContent = `${current.size} / ${ApnsPayloads.LIMIT} bytes` + (current.oversize ? ' - too large, the simulator refuses it' : '')
      sizeLabel.style.color = current.oversize ? 'var(--vscode-errorForeground)' : ''
      problemLabel.textContent = current.problem ?? ' '
      updateEnabled()
    }

    function updateBundleNote(): void {
      const id = bundleId()
      let text = ' '
      let warn = false
      if (id === '') text = 'Enter a bundle id'
      else if (!NotificationCommands.validBundleId(id)) {
        text = 'Not a valid bundle id'
        warn = true
      }
      else if (installed.length > 0 && !installed.includes(id)) {
        text = 'Not in the installed apps: simctl would still say sent'
        warn = true
      }
      bundleNote.textContent = text
      bundleNote.style.color = warn ? 'var(--vscode-errorForeground)' : ''
      updateEnabled()
    }

    async function loadApps(): Promise<void> {
      if (loadingApps) return
      loadingApps = true
      try {
        const r = await api.request<{ installed: string[]; foreground?: string }>('apps')
        installed = r.installed
        bundles.replaceChildren(...installed.map((id) => h('option', { value: id })))
        if (bundleId() === '') bundle.value = r.foreground ?? installed[0] ?? ''
        updateBundleNote()
      } catch {
        // the field stays free text
      }
      loadingApps = false
    }

    // ---- Android
    const aTitle = input('', { style: 'width:100%' })
    const aText = input('', { style: 'width:100%' })
    const aStyle = select(postStyles().map((s) => ({ value: s.name, label: s.label })), PostStyles.PLAIN.name)
    const aTag = input('mobiletestbench', { style: 'width:100%' })
    const aLines = area(3)
    const aConversation = input('', { style: 'width:100%' })
    const aMessages = area(3)
    const post = button('Post', () => void sendPost())
    const clear = button('Clear shell notifications', () => void sendClear())
    const iAction = input('', { style: 'width:100%' })
    const iPackage = input('', { style: 'width:100%' })
    const iComponent = input('', { style: 'width:100%' })
    const iExtras = area(3)
    const broadcast = button('Broadcast', () => void sendBroadcast())
    const inboxRow = labelled('Inbox lines (one per line)', aLines)
    const convRow = labelled('Conversation', aConversation)
    const msgRow = labelled('Messages (who:text per line)', aMessages)

    function showStyleFields(): void {
      inboxRow.style.display = aStyle.value === PostStyles.INBOX.name ? '' : 'none'
      const messaging = aStyle.value === PostStyles.MESSAGING.name
      convRow.style.display = messaging ? '' : 'none'
      msgRow.style.display = messaging ? '' : 'none'
    }

    const lines = (t: string) => t.split(/\r\n|\n|\r/)
    const postDto = () => ({ title: aTitle.value, text: aText.value, style: aStyle.value, tag: aTag.value, lines: lines(aLines.value), conversation: aConversation.value, messages: lines(aMessages.value).filter((m) => m.trim()) })
    const intentDto = () => ({ action: iAction.value, pkg: iPackage.value, component: iComponent.value, extras: iExtras.value })

    function updateEnabled(): void {
      iosSend.disabled = !(isIos && !busy && current.sendable && NotificationCommands.validBundleId(bundleId()))
      post.disabled = !(isAndroid && !busy)
      clear.disabled = post.disabled
      broadcast.disabled = post.disabled
    }

    /** Sends through the host; the result is shown and the history updated. */
    async function send(method: string, params: Record<string, unknown>): Promise<void> {
      if (busy) return
      busy = true
      updateEnabled()
      setResult('Sending...')
      try {
        const r = await api.request<SendReply>(method, params)
        setResult(r.result.text, r.result.error)
        entries = r.history
        fillHistory()
      } catch (e) {
        setResult((e as Error).message, true)
      }
      busy = false
      updateEnabled()
    }

    async function sendIos(): Promise<void> {
      if (!current.sendable) return
      await send('sendIos', { bundle: bundleId(), payload: current.compact, entry: historyEntry('ios', { bundle: bundleId(), payload: current.compact }) })
    }

    async function sendPost(): Promise<void> {
      const dto = postDto()
      const problem = NotificationCommands.postProblem({ ...dto, style: postStyles().find((s) => s.name === dto.style)! })
      if (problem) return setResult(problem, true)
      await send('sendPost', {
        post: dto,
        entry: historyEntry('post', { title: dto.title, text: dto.text, style: dto.style, tag: dto.tag, lines: aLines.value, conversation: dto.conversation, messages: aMessages.value }),
      })
    }

    const sendClear = () => send('sendClear', {})

    async function sendBroadcast(): Promise<void> {
      const i = intentDto()
      const problem = NotificationCommands.broadcastProblem(i)
      if (problem) return setResult(problem, true)
      await send('sendBroadcast', { intent: i, entry: historyEntry('intent', { action: i.action, package: i.pkg, component: i.component, extras: i.extras }) })
    }

    /** Fills the form of the matching platform from a remembered send. */
    function load(e: HistoryEntry): void {
      const f = e.fields
      if (e.kind === 'ios') {
        bundle.value = f.bundle ?? ''
        rawBox.checked = true
        raw.value = ApnsPayloads.inspect(f.payload ?? '').pretty
        showMode()
        updatePreview()
        updateBundleNote()
      } else if (e.kind === 'post') {
        aTitle.value = f.title ?? ''
        aText.value = f.text ?? ''
        aTag.value = f.tag ?? ''
        aStyle.value = postStyles().find((s) => s.name === f.style)?.name ?? PostStyles.PLAIN.name
        aLines.value = f.lines ?? ''
        aConversation.value = f.conversation ?? ''
        aMessages.value = f.messages ?? ''
        showStyleFields()
      } else {
        iAction.value = f.action ?? ''
        iPackage.value = f.package ?? ''
        iComponent.value = f.component ?? ''
        iExtras.value = f.extras ?? ''
      }
    }

    historySelect.addEventListener('change', () => {
      const e = shownHistory[Number(historySelect.value)]
      if (historySelect.value !== '' && e) load(e)
      // Back to the prompt so choosing the same entry again reloads it.
      historySelect.value = ''
    })
    for (const f of [fTitle, fSubtitle, fBody, fBadge, fSound, fCategory, fCustom, raw]) f.addEventListener('input', updatePreview)
    bundle.addEventListener('input', updateBundleNote)
    aStyle.addEventListener('change', showStyleFields)

    // ---- layout
    let card: HTMLElement
    if (isIos) {
      card = h(
        'div',
        {},
        labelled('App (bundle id)', h('span', {}, bundle, bundles)),
        labelled('', bundleNote),
        labelled('Mode', rawMode),
        ...formRows,
        ...rawRows,
        labelled('Payload sent', preview),
        labelled('', sizeLabel),
        labelled('', problemLabel),
        labelled('', iosSend),
        note(
          'The simulator accepts any bundle id. A banner only appears if the app has asked for and been granted notification permission (check Settings > Notifications in the simulator); simctl cannot grant it. "Notification sent" only means the simulator accepted the payload.',
        ),
      )
    } else if (isAndroid) {
      card = h(
        'div',
        {},
        h('div', {}, h('b', {}, 'Post a notification')),
        note(
          "It is posted by the Android shell package (com.android.shell), not by your app, so it cannot test your app's own notification handling, channels or tap actions. For FCM, trigger your app's own debug receiver with the Send intent group below, or use your backend or the Firebase console.",
        ),
        labelled('Title', aTitle),
        labelled('Text', aText),
        labelled('Style', aStyle),
        inboxRow,
        convRow,
        msgRow,
        labelled('Tag', aTag),
        labelled('', h('span', {}, post, ' ', clear)),
        note('Posting again with the same tag replaces the notification. Newlines are not supported in these fields.'),
        h('div', {}, h('b', {}, 'Send intent'), ' (am broadcast)'),
        labelled('Action', iAction),
        labelled('Package', iPackage),
        labelled('Component', iComponent),
        labelled('Extras (key=value per line)', iExtras),
        labelled('', broadcast),
        note(
          'Extras are strings unless prefixed: i:count=5, z:flag=true, l:big=1, f:x=1.5. A component (package/.Class) wins over the package. The result "completed: result=0" does NOT prove that a receiver exists or handled the intent.',
        ),
      )
    } else {
      card = h('div', { class: 'mtb-muted' }, api.device ? 'Notifications can only be sent to Android devices and iOS simulators (simctl push does not support physical iPhones).' : 'Not connected')
    }
    root.append(card, field('History', historySelect), result)
    showMode()
    showStyleFields()
    updatePreview()
    updateBundleNote()
    setResult(api.device ? ' ' : 'Not connected')
    updateEnabled()
    void api.request<HistoryEntry[]>('history').then((e) => {
      entries = e
      fillHistory()
    }, () => undefined)
    fillHistory()
    onShown = () => {
      if (isIos && installed.length === 0) void loadApps()
    }
  },

  shown() {
    onShown?.()
  },
}
