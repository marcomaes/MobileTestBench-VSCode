// ported-from: ui/InspectorPanel.kt
// ported-from: ui/PageObjectDialog.kt
// The Locators tab (webview half): the locator suggestions of the selected element with unique/dup badges, tooltips and the Copy as
// language, the locator query box (matches outlined on the mirror), the accessibility audit and the Generate Page Object dialog.
// What follows the selection is computed here (pure core code, browser safe); the audit, the page object code, Save and Insert at
// Caret are host calls (src/extension/tools/locators.ts). The element tree and its filter live in src/webview/inspector.ts.
import { LocatorHints, LocatorGenerator, type LocatorSuggestion } from '../../core/inspector/locators'
import { LocatorQuery } from '../../core/inspector/locatorQuery'
import type { UiNode } from '../../core/inspector/uiNode'
import { LocatorCode, LocatorLanguage } from '../../core/pageobject/locatorCode'
import { LocatorStyle, PageObjectLanguage } from '../../core/pageobject/pageObject'
import type { IssueRow, AuditDto, CandidateRow, GeneratedPageObject, PageObjectRequest } from '../../extension/locatorsModel'
import { nodeToDto } from '../inspector'
import type { ToolApi, ToolView } from '../toolApi'
import { button, checkbox, copyText, h, input, messageLine, select, table } from '../ui'

const GREEN = 'var(--vscode-testing-iconPassed, #208a3c)'
const RED = 'var(--vscode-errorForeground, #c7222d)'
const ORANGE = 'var(--vscode-editorWarning-foreground, #b26b00)'

type Settings = { locatorLanguage: string; locatorWholeLine: boolean; contrastHints: boolean }

const matchesText = (n: number): string => (n === 0 ? 'none' : n === 1 ? 'unique' : `dup (${n})`)

function mount(root: HTMLElement, api: ToolApi): { shown(): void; hidden(): void; deviceChanged(): void } {
  const inspector = api.viewer.inspector
  const settings: Settings = { locatorLanguage: 'AS_SHOWN', locatorWholeLine: false, contrastHints: true }
  let visible = false
  let selected: UiNode | undefined
  let rows: LocatorSuggestion[] = []
  let rowIndex = 0
  let auditGeneration = 0
  let auditDirty = false
  let issues: IssueRow[] = []
  let issueNodes: UiNode[] = []
  let paneOpen = 'Locators'

  // ---- Locators pane
  const queryInput = input('', { placeholder: "Try a locator: screen.getByTestId('...'), //XPath, id=..., By.id(\"...\"), -android uiautomator=..." })
  queryInput.style.flex = '1'
  queryInput.style.minWidth = '12em'
  const queryResult = h('span', { class: 'mtb-muted' }, ' ')
  const languageBox = select(
    LocatorLanguage.entries.map((l) => ({ value: l.name, label: l.label })),
    settings.locatorLanguage,
    (v) => {
      settings.locatorLanguage = v
      void api.request('set', { key: 'locatorLanguage', value: v })
      api.viewer.setCopyOptions(settings.locatorLanguage, settings.locatorWholeLine)
    },
  )
  languageBox.title = 'What double-click, Copy and Insert at Caret put on the clipboard or into the editor'
  const wholeLine = checkbox('Whole line', false, (v) => {
    settings.locatorWholeLine = v
    void api.request('set', { key: 'locatorWholeLine', value: v })
    api.viewer.setCopyOptions(settings.locatorLanguage, v)
  })
  wholeLine.title = 'Copy as a statement, e.g. driver.findElement(By.id("x")) or await $(\'~x\'), instead of the bare locator'
  const hint = h('div', { class: 'mtb-muted' }, 'Double-click a locator to copy it')
  const tableHost = h('div', {})
  const language = (): LocatorLanguage => LocatorLanguage.fromName(settings.locatorLanguage)
  const current = (): LocatorSuggestion | undefined => rows[rowIndex]

  const copy = (s: LocatorSuggestion): void => {
    const out = LocatorCode.textFor(s, language(), settings.locatorWholeLine)
    void copyText(out.text)
    hint.textContent = `Copied: ${out.text}` + (out.note ? ` (${out.note})` : '')
  }
  const insert = async (s: LocatorSuggestion): Promise<void> => {
    const out = LocatorCode.textFor(s, language(), settings.locatorWholeLine)
    const problem = await api.request<string>('insert', { text: out.text })
    hint.textContent = problem || `Inserted: ${out.text}` + (out.note ? ` (${out.note})` : '')
  }

  function renderRows(): void {
    const t = table(
      ['Framework', 'Strategy', 'Locator', 'Matches'],
      rows.map((r) => {
        const badge = h('span', {}, matchesText(r.matchCount))
        badge.style.color = r.isUnique ? GREEN : RED
        return [r.framework, (r.hint ? '⚠ ' : '') + (r.isBest ? `${r.strategy} (best)` : r.strategy), r.expression, badge]
      }),
      (i, tr) => {
        const r = rows[i]
        if (i === rowIndex) tr.classList.add('sel')
        const tip = LocatorHints.hintWithAlternative(r, rows)
        if (tip) tr.title = tip
        tr.onclick = () => {
          rowIndex = i
          for (const x of Array.from(tr.parentElement!.children)) x.classList.toggle('sel', x === tr)
        }
        tr.ondblclick = () => copy(r)
      },
    )
    tableHost.replaceChildren(t)
  }

  function showDetails(): void {
    const rootNode = inspector.root()
    rows = selected && rootNode && !selected.isRoot ? LocatorGenerator.suggest(selected, rootNode) : []
    rowIndex = 0
    renderRows()
  }

  /** Evaluates the typed locator against the current hierarchy and outlines the matches on the screen. */
  function runQuery(): void {
    const tree = inspector.root()
    if (queryInput.value.trim() === '' || !tree) {
      queryResult.textContent = ' '
      inspector.setMatchBounds([])
      return
    }
    try {
      const matches = LocatorQuery.find(queryInput.value, tree)
      queryResult.style.color = matches.length === 1 ? GREEN : RED
      queryResult.textContent = matches.length === 0 ? 'No match' : matches.length === 1 ? '1 match (unique)' : `${matches.length} matches`
      inspector.setMatchBounds(matches.flatMap((n) => (n.bounds ? [n.bounds] : [])))
    } catch (e) {
      queryResult.style.color = ''
      queryResult.textContent = (e instanceof Error ? e.message : '') || 'Invalid locator'
      inspector.setMatchBounds([])
    }
  }
  queryInput.addEventListener('input', runQuery)

  const locatorsPane = h(
    'div',
    {},
    h('div', { class: 'mtb-row' }, queryInput, h('span', {}, 'Copy as:'), languageBox, wholeLine),
    queryResult,
    tableHost,
    h('div', { class: 'mtb-row' }, button('Copy', () => current() && copy(current()!)), button('Insert at Caret', () => current() && insert(current()!)), hint),
  )

  // ---- Accessibility pane
  const auditStatus = h('span', { class: 'mtb-muted' }, ' ')
  const contrastBox = checkbox('Contrast hints', settings.contrastHints, (v) => {
    settings.contrastHints = v
    void api.request('set', { key: 'contrastHints', value: v })
    runAudit()
  })
  contrastBox.title = 'Estimates text contrast (WCAG 1.4.3) from the screen image. A heuristic: treat results as hints.'
  const issueHost = h('div', {})
  const accessibilityPane = h('div', {}, h('div', { class: 'mtb-row' }, auditStatus, contrastBox), issueHost)

  function publishIssues(): void {
    // The issues are outlined on the screen only while their tab is open.
    const open = visible && paneOpen === 'Accessibility'
    inspector.setIssueBounds(open ? issueNodes.flatMap((n) => (n.bounds ? [n.bounds] : [])) : [])
  }

  function renderIssues(): void {
    const t = table(
      ['Element', 'Kind', 'Issue'],
      issues.map((i) => {
        const kind = h('span', {}, i.title)
        // AA failures red, guidance orange, hints gray.
        kind.style.color = i.rule === 'MISSING_NAME' || i.rule === 'TARGET_BELOW_MINIMUM' ? RED : i.rule === 'TARGET_BELOW_RECOMMENDED' ? ORANGE : ''
        return [i.elementLabel, kind, i.message]
      }),
      (i, tr) => {
        tr.title = issues[i].message
        tr.onclick = () => {
          const node = issueNodes[i]
          if (node) inspector.select(node)
        }
      },
    )
    issueHost.replaceChildren(t)
    paneButtons.get('Accessibility')!.textContent = issues.length === 0 ? 'Accessibility' : `Accessibility (${issues.length})`
    publishIssues()
  }

  /** The audit samples pixels and may ask the device for its density, so it runs on the host; a newer run drops an older result. */
  let auditInput: { root: UiNode; frameBase64?: string } | undefined
  function runAudit(): void {
    const generation = ++auditGeneration
    const input_ = auditInput
    if (!input_) {
      issues = []
      issueNodes = []
      auditStatus.textContent = ' '
      renderIssues()
      return
    }
    auditDirty = false
    const all = [...input_.root.walk()]
    api
      .request<AuditDto>('audit', { root: nodeToDto(input_.root), frameBase64: input_.frameBase64, contrast: settings.contrastHints })
      .then((result) => {
        if (generation !== auditGeneration) return
        issues = result.issues.filter((i) => all[i.index])
        issueNodes = issues.map((i) => all[i.index])
        auditStatus.textContent = result.statusLine
        renderIssues()
      })
      .catch(() => {
        if (generation !== auditGeneration) return
        issues = []
        issueNodes = []
        auditStatus.textContent = 'Accessibility audit failed'
        renderIssues()
      })
  }

  // ---- Page Object pane
  const pageObjectPane = h('div', {})
  const openBtn = button('Generate Page Object...', () => void openPageObject(), { title: 'Build a page object class from the elements of the current screen' })
  const pageStatus = messageLine()
  pageObjectPane.append(h('div', { class: 'mtb-row' }, openBtn), pageStatus)
  const pageBody = h('div', {})
  pageObjectPane.append(pageBody)

  async function openPageObject(): Promise<void> {
    const tree = inspector.root()
    if (!tree) return pageStatus.error('No hierarchy yet: connect a device and press Inspect')
    pageStatus.set('Preparing the page object...')
    try {
      const init = await api.request<{ mobilewright: CandidateRow[]; appium: CandidateRow[]; language: string; style: string; baseClass: string; generateBase: boolean; sortByName: boolean }>('pageObject.open', { root: nodeToDto(tree) })
      pageStatus.set(' ')
      buildDialog(init)
    } catch (e) {
      pageStatus.error(e instanceof Error ? e.message : String(e))
    }
  }

  function buildDialog(init: { mobilewright: CandidateRow[]; appium: CandidateRow[]; language: string; style: string; baseClass: string; generateBase: boolean; sortByName: boolean }): void {
    type Row = { c: CandidateRow; name: string; selected: boolean }
    /** Name and tick of each element survive a switch between Mobilewright and Appium (their locators differ). */
    const choices = new Map<number, { name: string; selected: boolean }>()
    let list: Row[] = []
    let tab: 'page' | 'base' = 'page'
    let result: GeneratedPageObject | undefined
    let generation = 0
    const className = input('ScreenPage', { size: 14 })
    const language_ = select(PageObjectLanguage.entries.map((l) => ({ value: l.name, label: l.label })), init.language)
    const style = select(LocatorStyle.entries.map((l) => ({ value: l.name, label: l.label })), init.style)
    const baseClass = input(init.baseClass, { size: 12 })
    const generateBase = checkbox('Generate the base class', init.generateBase)
    const sortByName = checkbox('Sort by name', init.sortByName)
    const status = messageLine()
    const rowsHost = h('div', { style: 'max-height: 30vh; overflow: auto' })
    const preview = h('pre', { class: 'mtb-code', style: 'max-height: 30vh; overflow: auto; margin: 0' })
    const pageTab = h('button', { class: 'mtb-btn on', onclick: () => switchTab('page') }, 'Page object')
    const baseTab = h('button', { class: 'mtb-btn', onclick: () => switchTab('base') }, 'Base class')
    const appium = (): boolean => PageObjectLanguage.entries.find((l) => l.name === language_.value)?.appium ?? false
    const usesBase = (): boolean => LocatorStyle.entries.find((l) => l.name === style.value)?.usesBaseClass ?? true
    const checks = (): HTMLInputElement[] => Array.from(generateBase.querySelectorAll('input'))
    const request = (): PageObjectRequest => ({
      appium: appium(),
      rows: list.map((r) => ({ index: r.c.index, name: r.name, selected: r.selected && r.c.locator !== undefined })),
      className: className.value,
      language: language_.value,
      style: style.value,
      baseClass: baseClass.value,
      generateBase: generateBase.querySelector('input')!.checked,
      sortByName: sortByName.querySelector('input')!.checked,
    })

    function loadRows(): void {
      for (const r of list) choices.set(r.c.index, { name: r.name, selected: r.selected })
      list = (appium() ? init.appium : init.mobilewright).map((c) => {
        const remembered = choices.get(c.index)
        return { c, name: remembered?.name ?? c.name, selected: remembered?.selected ?? c.selectedByDefault }
      })
      renderRowTable()
      void regenerate(true)
    }

    function renderRowTable(): void {
      const t = table(
        ['', 'Name', 'Type', 'Locator'],
        list.map((r) => {
          const has = r.c.locator !== undefined
          const box = h('input', { type: 'checkbox', checked: r.selected && has, disabled: !has })
          box.addEventListener('change', () => {
            r.selected = box.checked
            void regenerate(false)
          })
          const name = h('input', { class: 'mtb-input', type: 'text', value: r.name, disabled: !has })
          name.addEventListener('input', () => {
            r.name = name.value
            void regenerate(false)
          })
          const locator = h('span', { class: has ? '' : 'mtb-muted' }, r.c.locator ?? 'no unique locator')
          return [box, name, h('span', { class: has ? '' : 'mtb-muted' }, r.c.typeName), locator]
        }),
      )
      rowsHost.replaceChildren(t)
    }

    /** Remembers the choices (when [persist]) and rewrites the code. */
    async function regenerate(persist: boolean): Promise<void> {
      const id = ++generation
      baseClass.disabled = !usesBase()
      for (const c of checks()) c.disabled = !usesBase()
      try {
        const r = await api.request<GeneratedPageObject>('pageObject.generate', { request: request(), persist })
        if (id !== generation) return
        result = r
        baseTab.disabled = r.base === undefined
        if (r.base === undefined && tab === 'base') switchTab('page')
        else showPreview()
        status.set(r.status)
      } catch (e) {
        status.error(e instanceof Error ? e.message : String(e))
      }
    }

    function showPreview(): void {
      preview.textContent = (tab === 'base' ? result?.base : result?.page) ?? ''
    }
    function switchTab(next: 'page' | 'base'): void {
      tab = next
      pageTab.classList.toggle('on', next === 'page')
      baseTab.classList.toggle('on', next === 'base')
      showPreview()
    }
    const currentText = (): string => (tab === 'base' ? result?.base : result?.page) ?? ''

    className.addEventListener('input', () => void regenerate(false))
    baseClass.addEventListener('input', () => void regenerate(false))
    baseClass.addEventListener('change', () => void regenerate(true))
    language_.addEventListener('change', loadRows)
    style.addEventListener('change', () => void regenerate(true))
    generateBase.addEventListener('change', () => void regenerate(true))
    sortByName.addEventListener('change', () => void regenerate(true))

    pageBody.replaceChildren(
      h('div', { class: 'mtb-row' }, h('span', {}, 'Class name:'), className, h('span', {}, 'Language:'), language_, h('span', {}, 'Locators:'), style),
      h('div', { class: 'mtb-row' }, h('span', {}, 'Base class:'), baseClass, generateBase, sortByName),
      rowsHost,
      h('div', { class: 'mtb-row' }, pageTab, baseTab),
      preview,
      h(
        'div',
        { class: 'mtb-row' },
        status,
        button('Copy', async () => {
          await copyText(currentText())
          status.set('Copied')
        }),
        button('Insert at Caret', async () => status.set((await api.request<string>('insert', { text: currentText() })) || 'Inserted')),
        button('Save...', async () => {
          if (!result) return
          const message = await api.request<string>('pageObject.save', {
            text: currentText(),
            fileName: tab === 'base' ? result.baseFileName : result.pageFileName,
            language: language_.value,
          })
          if (message) status.set(message)
        }),
        button('Close', () => pageBody.replaceChildren()),
      ),
    )
    loadRows()
  }

  // ---- sub tabs
  const panes: Array<[string, HTMLElement]> = [
    ['Locators', locatorsPane],
    ['Accessibility', accessibilityPane],
    ['Page Object', pageObjectPane],
  ]
  const paneButtons = new Map<string, HTMLButtonElement>()
  const strip = h('div', { class: 'mtb-row', style: 'border-bottom: 1px solid var(--vscode-panel-border); margin-top: 0' })
  function showPane(title: string): void {
    paneOpen = title
    for (const [t, el] of panes) el.style.display = t === title ? '' : 'none'
    for (const [t, b] of paneButtons) b.style.fontWeight = t === title ? '600' : ''
    publishIssues()
  }
  for (const [title] of panes) {
    const b = h('button', { class: 'mtb-btn', style: 'background: transparent; color: var(--vscode-foreground)', onclick: () => showPane(title) }, title)
    paneButtons.set(title, b)
    strip.append(b)
  }
  root.append(strip, ...panes.map(([, el]) => el))
  showPane('Locators')
  renderRows()
  renderIssues()

  // ---- follow the inspector
  inspector.onSelection((node) => {
    selected = node
    showDetails()
  })
  inspector.onHierarchy((tree, frameBase64) => {
    selected = undefined
    auditInput = { root: tree, frameBase64 }
    showDetails()
    runQuery()
    if (visible) runAudit()
    else auditDirty = true
  })
  inspector.onCleared(() => {
    selected = undefined
    auditInput = undefined
    showDetails()
    runQuery()
    runAudit()
  })

  void api.request<Partial<Settings>>('state').then((s) => {
    Object.assign(settings, s)
    languageBox.value = LocatorLanguage.fromName(settings.locatorLanguage).name
    wholeLine.querySelector('input')!.checked = settings.locatorWholeLine
    contrastBox.querySelector('input')!.checked = settings.contrastHints
    api.viewer.setCopyOptions(settings.locatorLanguage, settings.locatorWholeLine)
    renderRows()
    if (visible) runAudit()
  })

  // The tab can be mounted after a hierarchy was captured.
  const existing = inspector.root()
  if (existing) {
    auditInput = { root: existing }
    selected = inspector.selected()
    showDetails()
  }

  return {
    shown() {
      visible = true
      if (auditDirty || (auditInput && issues.length === 0)) runAudit()
      publishIssues()
    },
    hidden() {
      visible = false
      publishIssues()
    },
    deviceChanged() {},
  }
}

let instance: ReturnType<typeof mount> | undefined

export const locatorsView: ToolView = {
  id: 'locators',
  title: 'Locators',
  mount(root, api) {
    instance = mount(root, api)
  },
  shown: () => instance?.shown(),
  hidden: () => instance?.hidden(),
  deviceChanged: () => instance?.deviceChanged(),
}
