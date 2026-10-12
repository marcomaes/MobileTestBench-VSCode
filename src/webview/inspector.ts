// ported-from: ui/InspectorPanel.kt
// The element inspector of the viewer page: the hierarchy tree with a properties table, in a tab strip so more tabs can be added.
// The viewer (mirror.ts) owns the capture (host round trip, freeze, auto refresh); this module only shows what it is given.
//
// Extending it (Locators, Recorder, Page object, filter, accessibility audit): call `addTab(title, element)` for a new tab,
// `onSelection` / `onHierarchy` to follow what the user picks or what was captured, `select(node)` to pick programmatically
// and `setMatchBounds` / `setIssueBounds` to draw rectangles on the mirror (logical coordinates).
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
  setMatchBounds(rects: Rect[]): void
  setIssueBounds(rects: Rect[]): void
}

const ELEMENTS = 'Elements'

export function createInspector(container: HTMLElement, options: InspectorOptions = {}): Inspector {
  let root: UiNode | undefined
  let selected: UiNode | undefined
  const rowOf = new Map<UiNode, HTMLElement>()
  const selectionListeners = new Set<(n: UiNode | undefined) => void>()
  const hierarchyListeners = new Set<(r: UiNode, f?: string) => void>()

  container.classList.add('mtb-inspector')
  const tabs = document.createElement('div')
  tabs.className = 'mtb-itabs'
  const body = document.createElement('div')
  body.className = 'mtb-ibody'
  container.append(tabs, body)

  const treeEl = document.createElement('div')
  treeEl.className = 'mtb-itree'
  const propsEl = document.createElement('div')
  propsEl.className = 'mtb-iprops'
  const elements = document.createElement('div')
  elements.className = 'mtb-ipane mtb-ielements'
  elements.append(treeEl, propsEl)

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

  function renderTree(): void {
    treeEl.textContent = ''
    rowOf.clear()
    if (!root) return
    const add = (n: UiNode): void => {
      const row = document.createElement('div')
      row.className = 'mtb-irow'
      row.textContent = '  '.repeat(n.depth) + n.displayLabel()
      row.onclick = () => select(n)
      rowOf.set(n, row)
      treeEl.append(row)
      n.children.forEach(add)
    }
    add(root)
  }

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

  function message(text: string, error = false): void {
    root = undefined
    selected = undefined
    rowOf.clear()
    propsEl.textContent = ''
    treeEl.textContent = ''
    const m = document.createElement('div')
    m.className = error ? 'mtb-imsg err' : 'mtb-imsg'
    m.textContent = text
    treeEl.append(m)
    options.onSelect?.(undefined)
  }

  message('Connect a device, then press Inspect.')

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
  .mtb-itree { overflow: auto; padding: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .mtb-irow { white-space: pre; cursor: pointer; padding: 0 2px; }
  .mtb-irow:hover { background: var(--vscode-list-hoverBackground); }
  .mtb-irow.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .mtb-imsg { opacity: .8; padding: 4px; white-space: pre-wrap; } .mtb-imsg.err { color: var(--vscode-errorForeground); opacity: 1; }
  .mtb-iprops { max-height: 35vh; overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
  .mtb-iprops table { border-collapse: collapse; } .mtb-iprops td { padding: 1px 8px 1px 0; vertical-align: top; } .mtb-iprops td:first-child { opacity: .7; white-space: nowrap; }
`
