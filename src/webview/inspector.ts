// ported-from: ui/InspectorPanel.kt
// The element inspector of the viewer page: the hierarchy tree with a properties table, in a tab strip so more tabs can be added.
// The viewer (mirror.ts) owns the capture (host round trip, freeze, auto refresh); this module only shows what it is given.
//
// Extending it (Locators, Recorder, Page object, filter, accessibility audit): call `addTab(title, element)` for a new tab,
// `onSelection` / `onHierarchy` to follow what the user picks or what was captured, `select(node)` to pick programmatically
// and `setMatchBounds` / `setIssueBounds` to draw rectangles on the mirror (logical coordinates).
import { FilterCriteria, HierarchyFilter } from '../core/inspector/hierarchyFilter'
import { MobilewrightLocators } from '../core/inspector/locators'
import { UiNode } from '../core/inspector/uiNode'
import type { Rect } from '../core/model'
import type { NodeDto } from '../protocol'

/** A UI hierarchy node from the host, rebuilt as a core UiNode (children in the same depth first order). */
export function nodeFromDto(dto: NodeDto): UiNode {
  const node = new UiNode(dto.platform, dto.rawType, dto.attributes, dto.bounds)
  for (const c of dto.children) node.addChild(nodeFromDto(c))
  return node
}

export function nodeToDto(n: UiNode): NodeDto {
  return { platform: n.platform, rawType: n.rawType, attributes: { ...n.attributes }, bounds: n.bounds, children: n.children.map(nodeToDto) }
}

/** What the inspector needs from the viewer page. */
export interface InspectorOptions {
  /** The selection changed (the mirror outlines its bounds). */
  onSelect?: (node: UiNode | undefined) => void
  /** Rectangles to draw on the mirror for the matches of a locator the user tries. */
  setMatchBounds?: (rects: Rect[]) => void
  /** Rectangles to draw on the mirror for elements with an accessibility issue. */
  setIssueBounds?: (rects: Rect[]) => void
  /** The filter text changed by the user (the viewer saves it in the setting elementFilter). */
  onFilterChange?: (text: string) => void
  /** Right click on a tree row; [x], [y] are client coordinates. */
  onContextMenu?: (node: UiNode, x: number, y: number) => void
  /** The initial filter text (setting elementFilter). */
  filterText?: string
}

export interface Inspector {
  readonly element: HTMLElement
  /** The hierarchy shown, undefined before the first capture or after [clear]. */
  root(): UiNode | undefined
  selected(): UiNode | undefined
  /** Shows a tree. [frameBase64]: the frame current when the capture started (for the contrast rule of the audit). */
  setHierarchy(root: UiNode, frameBase64?: string): void
  /** Replaces the content by a message (Loading..., No hierarchy). */
  setMessage(text: string): void
  setError(text: string): void
  /** Forgets tree and selection and shows [text]. */
  clear(text?: string): void
  /** Selects [node] (undefined clears the selection), scrolls it into view and tells the listeners. */
  select(node: UiNode | undefined): void
  /** Adds a tab after the existing ones. */
  addTab(title: string, content: HTMLElement): void
  showTab(title: string): void
  onSelection(cb: (node: UiNode | undefined) => void): () => void
  onHierarchy(cb: (root: UiNode, frameBase64?: string) => void): () => void
  /** The hierarchy was forgotten (a message, an error, no session): tools showing it should empty themselves. */
  onCleared(cb: () => void): () => void
  setMatchBounds(rects: Rect[]): void
  setIssueBounds(rects: Rect[]): void
  /** Puts [text] in the filter field and narrows the tree (no change callback). */
  setFilterText(text: string): void
}

const ELEMENTS = 'Elements'

export function createInspector(container: HTMLElement, options: InspectorOptions = {}): Inspector {
  let root: UiNode | undefined
  let selected: UiNode | undefined
  const rowOf = new Map<UiNode, HTMLElement>()
  const selectionListeners = new Set<(n: UiNode | undefined) => void>()
  const hierarchyListeners = new Set<(r: UiNode, f?: string) => void>()
  const clearedListeners = new Set<() => void>()

  container.classList.add('mtb-inspector')
  const tabs = document.createElement('div')
  tabs.className = 'mtb-itabs'
  const body = document.createElement('div')
  body.className = 'mtb-ibody'
  container.append(tabs, body)

  // The filter above the tree (Kotlin: filterField, Visible, Interactive and the "Not understood" line).
  const filterInput = document.createElement('input')
  filterInput.className = 'mtb-ifilter'
  filterInput.type = 'text'
  filterInput.value = options.filterText ?? ''
  filterInput.placeholder = 'Filter: text, or clickable=true class~Button'
  filterInput.title = [
    'Free text matches type, id, label, text and value.',
    'A word with a leading - or ! must not match: -error, -clickable=true.',
    '/regex/ is a case-insensitive regular expression (quote it if it has spaces).',
    'OR (or |) between groups shows elements matching either group: Login OR Sign.',
    'Attribute terms, separated by spaces, must all match:',
    ' key=value (equals), key!=value (not equal), key~value (contains), case-insensitive.',
    'Quote a value with spaces: text="Log in".',
    'Keys: enabled, clickable, focused, checked, selected, visible (true/false),',
    ' type or class, id or resource-id, label, text, content-desc, value.',
    'Any other key is read from the raw attributes. Example: clickable=true enabled=false class~Button',
  ].join('\n')
  const visibleBox = document.createElement('input')
  visibleBox.type = 'checkbox'
  const interactiveBox = document.createElement('input')
  interactiveBox.type = 'checkbox'
  const filterBar = document.createElement('div')
  filterBar.className = 'mtb-ifilterbar'
  const checkLabel = (box: HTMLInputElement, text: string): HTMLLabelElement => {
    const l = document.createElement('label')
    l.append(box, text)
    return l
  }
  filterBar.append(filterInput, checkLabel(visibleBox, 'Visible'), checkLabel(interactiveBox, 'Interactive'))
  const filterProblem = document.createElement('div')
  filterProblem.className = 'mtb-ifilterproblem'
  filterProblem.style.display = 'none'

  const treeEl = document.createElement('div')
  treeEl.className = 'mtb-itree'
  const treeWrap = document.createElement('div')
  treeWrap.className = 'mtb-itreewrap'
  treeWrap.append(filterBar, filterProblem, treeEl)
  const propsEl = document.createElement('div')
  propsEl.className = 'mtb-iprops'
  const elements = document.createElement('div')
  elements.className = 'mtb-ipane mtb-ielements'
  elements.append(treeWrap, propsEl)

  const panes = new Map<string, HTMLElement>()
  const tabButtons = new Map<string, HTMLButtonElement>()
  function addTab(title: string, content: HTMLElement): void {
    content.classList.add('mtb-ipane')
    panes.set(title, content)
    body.append(content)
    const b = document.createElement('button')
    b.textContent = title
    b.onclick = () => showTab(title)
    tabButtons.set(title, b)
    tabs.append(b)
    if (panes.size === 1) showTab(title)
  }
  function showTab(title: string): void {
    if (!panes.has(title)) return
    for (const [t, el] of panes) el.classList.toggle('on', t === title)
    for (const [t, b] of tabButtons) b.classList.toggle('on', t === title)
  }
  addTab(ELEMENTS, elements)

  /** Fills the tree from [root], narrowed by the filter (Kotlin rebuildTree). */
  function renderTree(): void {
    treeEl.textContent = ''
    rowOf.clear()
    if (!root) {
      filterProblem.style.display = 'none'
      return
    }
    const criteria = new FilterCriteria({ text: filterInput.value, visibleOnly: visibleBox.checked, interactiveOnly: interactiveBox.checked })
    const shown = HierarchyFilter.visibleNodes(root, criteria)
    const problems = criteria.invalidTerms
    filterProblem.style.display = problems.length > 0 ? 'block' : 'none'
    filterProblem.textContent = 'Not understood: ' + problems.map((it) => `${it.text} (${it.reason})`).join('; ')
    if (shown && shown.size === 0) {
      const m = document.createElement('div')
      m.className = 'mtb-imsg'
      m.textContent = 'No element matches the filter'
      treeEl.append(m)
      return
    }
    const add = (n: UiNode): void => {
      const row = document.createElement('div')
      row.className = 'mtb-irow'
      row.textContent = '  '.repeat(n.depth) + n.displayLabel() + (!n.isRoot && MobilewrightLocators.derive(n) === undefined ? '  (no locator)' : '')
      row.onclick = () => select(n)
      row.oncontextmenu = (e) => {
        e.preventDefault()
        select(n)
        options.onContextMenu?.(n, e.clientX, e.clientY)
      }
      if (n === selected) row.classList.add('sel')
      rowOf.set(n, row)
      treeEl.append(row)
      for (const c of n.children) if (!shown || shown.has(c)) add(c)
    }
    add(root)
  }
  let filterQuiet = false
  const onFilter = (): void => {
    renderTree()
    if (!filterQuiet) options.onFilterChange?.(filterInput.value)
  }
  filterInput.addEventListener('input', onFilter)
  visibleBox.addEventListener('change', onFilter)
  interactiveBox.addEventListener('change', onFilter)

  function renderProps(): void {
    propsEl.textContent = ''
    const n = selected
    if (!n) return
    const table = document.createElement('table')
    const rows: Array<[string, string | undefined]> = [
      ['type', n.rawType],
      ['label', n.label],
      ['text', n.text],
      ['value', n.value],
      ['identifier', n.identifier],
      ['resource-id', n.resourceId],
      ['bounds', n.bounds ? `${n.bounds.x},${n.bounds.y} ${n.bounds.width}×${n.bounds.height}` : undefined],
      ['xpath', n.absoluteXPath()],
    ]
    for (const [k, v] of rows) {
      if (v === undefined) continue
      const tr = table.insertRow()
      tr.insertCell().textContent = k
      tr.insertCell().textContent = v
    }
    propsEl.append(table)
  }

  function select(n: UiNode | undefined): void {
    selected = n
    for (const [node, row] of rowOf) row.classList.toggle('sel', node === n)
    if (n) rowOf.get(n)?.scrollIntoView({ block: 'nearest' })
    renderProps()
    options.onSelect?.(n)
    selectionListeners.forEach((cb) => cb(n))
  }

  function message(text: string, error = false, notify = true): void {
    root = undefined
    selected = undefined
    rowOf.clear()
    propsEl.textContent = ''
    treeEl.textContent = ''
    const m = document.createElement('div')
    m.className = error ? 'mtb-imsg err' : 'mtb-imsg'
    m.textContent = text
    treeEl.append(m)
    filterProblem.style.display = 'none'
    // The first message runs during setup, before the owner finished building its own page: nobody to tell yet.
    if (!notify) return
    options.onSelect?.(undefined)
    selectionListeners.forEach((cb) => cb(undefined))
    clearedListeners.forEach((cb) => cb())
  }

  message('Connect a device, then press Inspect.', false, false)

  return {
    element: container,
    root: () => root,
    selected: () => selected,
    setHierarchy(next, frameBase64) {
      root = next
      selected = undefined
      renderTree()
      renderProps()
      options.onSelect?.(undefined)
      selectionListeners.forEach((cb) => cb(undefined))
      hierarchyListeners.forEach((cb) => cb(next, frameBase64))
    },
    setMessage: (text) => message(text),
    setError: (text) => message(text, true),
    clear: (text = 'No hierarchy') => message(text),
    select,
    addTab,
    showTab,
    onSelection(cb) {
      selectionListeners.add(cb)
      return () => selectionListeners.delete(cb)
    },
    onHierarchy(cb) {
      hierarchyListeners.add(cb)
      return () => hierarchyListeners.delete(cb)
    },
    onCleared(cb) {
      clearedListeners.add(cb)
      return () => clearedListeners.delete(cb)
    },
    setFilterText(text) {
      filterInput.value = text
      filterQuiet = true
      try {
        renderTree()
      } finally {
        filterQuiet = false
      }
    },
    setMatchBounds: (rects) => options.setMatchBounds?.(rects),
    setIssueBounds: (rects) => options.setIssueBounds?.(rects),
  }
}

/** The CSS of the inspector; the viewer adds it to its page style. */
export const inspectorCss = `
  .mtb-inspector { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  .mtb-itabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
  .mtb-itabs button { background: transparent; color: var(--vscode-foreground); border: 0; border-bottom: 2px solid transparent; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .mtb-itabs button.on { border-bottom-color: var(--vscode-focusBorder); }
  .mtb-ibody { flex: 1; min-height: 0; position: relative; }
  .mtb-ipane { display: none; height: 100%; overflow: auto; }
  .mtb-ipane.on { display: block; }
  .mtb-ipane.mtb-ielements.on { display: grid; grid-template-rows: 1fr auto; overflow: hidden; }
  .mtb-itreewrap { display: flex; flex-direction: column; min-height: 0; }
  .mtb-ifilterbar { display: flex; gap: 8px; align-items: center; padding: 3px 4px; flex: none; }
  .mtb-ifilter { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; }
  .mtb-ifilterbar label { white-space: nowrap; display: inline-flex; gap: 2px; align-items: center; }
  .mtb-ifilterproblem { color: var(--vscode-errorForeground); padding: 0 6px 2px; font-size: 12px; flex: none; }
  .mtb-itree { flex: 1; min-height: 0; overflow: auto; padding: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .mtb-irow { white-space: pre; cursor: pointer; padding: 0 2px; }
  .mtb-irow:hover { background: var(--vscode-list-hoverBackground); }
  .mtb-irow.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .mtb-imsg { opacity: .8; padding: 4px; white-space: pre-wrap; } .mtb-imsg.err { color: var(--vscode-errorForeground); opacity: 1; }
  .mtb-iprops { max-height: 35vh; overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
  .mtb-iprops table { border-collapse: collapse; } .mtb-iprops td { padding: 1px 8px 1px 0; vertical-align: top; } .mtb-iprops td:first-child { opacity: .7; white-space: nowrap; }
`
