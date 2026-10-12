// ported-from: ui/WebViewPanel.kt
import type { ToolApi, ToolView } from '../toolApi'
import { button, checkbox, copyText, h, select, table } from '../ui'

interface TreeDto {
  key: string
  label: string
  text: string
  nonVisual: boolean
  children: TreeDto[]
}
interface Listing {
  views: Array<{ id: string; label: string }>
  currentId: string | undefined
  status: { text: string; error: boolean }
  tree: TreeDto | undefined
  owner: string
}
interface Selection {
  seq: number
  css: string
  xpath: string
  cssCount: number
  xpathCount: number
  cssText: string
  xpathText: string
  attrs: Array<[string, string]>
}
interface Live {
  seq: number
  failed?: string
  cssCount?: number
  cssError?: string
  xpathCount?: number
  xpathError?: string
  cssText?: string
  xpathText?: string
  note?: string
}
interface EvalResult {
  text: string
  error: boolean
  notFound: boolean
}

const CSS = `
  .mtb-wv { display: flex; flex-direction: column; gap: 4px; }
  .mtb-wv-main { display: flex; gap: 8px; flex-wrap: wrap; }
  .mtb-wv-left { flex: 1 1 280px; min-width: 240px; }
  .mtb-wv-right { flex: 2 1 380px; min-width: 300px; }
  .mtb-wv-tree { max-height: 340px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; border: 1px solid var(--vscode-panel-border); }
  .mtb-wv-tree .row { white-space: nowrap; cursor: pointer; padding: 0 2px; }
  .mtb-wv-tree .row:hover { background: var(--vscode-list-hoverBackground); }
  .mtb-wv-tree .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .mtb-wv-tree .row.nv { opacity: .55; }
  .mtb-wv-tree .twisty { display: inline-block; width: 14px; text-align: center; }
  .mtb-wv-field { flex: 1; font-family: var(--vscode-editor-font-family); min-width: 120px; }
  .mtb-wv-label { width: 44px; display: inline-block; }
  .mtb-wv-attrs { max-height: 160px; overflow: auto; }
  .mtb-wv-code { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .mtb-wv-out { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); max-height: 160px; overflow: auto; margin: 2px 0; }
  .mtb-wv .ok { color: var(--vscode-charts-green, #5FB865); } .mtb-wv .warn { color: var(--vscode-charts-orange, #D9A343); } .mtb-wv .bad { color: var(--vscode-errorForeground, #E55765); }
`

/** unique = green, no match or invalid = red, several = orange (Kotlin `matchColor`). */
const matchClass = (count: number | undefined, error: string | undefined): string => (error !== undefined || count === 0 ? 'bad' : count === 1 ? 'ok' : 'warn')

let onShown: (() => void) | undefined

export const webviewView: ToolView = {
  id: 'webview',
  title: 'WebView',

  mount(root: HTMLElement, api: ToolApi) {
    if (!document.getElementById('mtb-wv-styles')) {
      const style = h('style', { id: 'mtb-wv-styles' })
      style.textContent = CSS
      document.head.append(style)
    }
    let loaded = false
    let tree: TreeDto | undefined
    let selectedKey: string | undefined
    let selSeq = 0
    let busy = false
    const expanded = new Set<string>()
    const collapsed = new Set<string>()

    const status = h('div', { class: 'mtb-msg' })
    const owner = h('div', { class: 'mtb-muted' })
    const combo = select([], undefined, () => void loadDom())
    const refreshBtn = button('Refresh', () => void refresh())
    const reloadBtn = button('Reload DOM', () => void loadDom())
    const showNonVisual = checkbox('Show head, script and style nodes', false, () => renderTree())
    const treeBox = h('div', { class: 'mtb-wv-tree' })

    const cssField = h('input', { class: 'mtb-input mtb-wv-field', type: 'text', readonly: true })
    const xpathField = h('input', { class: 'mtb-input mtb-wv-field', type: 'text', readonly: true })
    const cssMatch = h('span')
    const xpathMatch = h('span')
    const selectedNote = h('div', { class: 'mtb-muted' })
    const attrBox = h('div', { class: 'mtb-wv-attrs' })

    const code = h('textarea', { class: 'mtb-wv-code', rows: 4 })
    const runBtn = button('Run', () => void runScript())
    const output = h('div', { class: 'mtb-wv-out mtb-muted' })

    const setStatus = (text: string, error = false): void => {
      status.className = error ? 'mtb-msg err' : 'mtb-msg'
      status.textContent = text || ' '
    }
    const updateButtons = (): void => {
      const has = combo.options.length > 0
      refreshBtn.disabled = busy
      reloadBtn.disabled = !has || busy
      runBtn.disabled = !has
    }
    const clearSelectionView = (): void => {
      cssField.value = ''
      xpathField.value = ''
      cssMatch.textContent = ' '
      xpathMatch.textContent = ' '
      attrBox.replaceChildren()
      selectedNote.textContent = ' '
    }

    const renderTree = (): void => {
      treeBox.replaceChildren()
      if (!tree) return
      const withHidden = showNonVisual.querySelector('input')?.checked === true
      const add = (n: TreeDto, depth: number): void => {
        const kids = n.children.filter((c) => withHidden || !c.nonVisual)
        // Open html and body so the page content is visible straight away.
        const open = expanded.has(n.key) || (depth < 2 && !collapsed.has(n.key))
        const twisty = h('span', { class: 'twisty' }, kids.length ? (open ? '▾' : '▸') : '')
        const row = h(
          'div',
          { class: `row${n.nonVisual ? ' nv' : ''}${n.key === selectedKey ? ' sel' : ''}`, style: `padding-left:${depth * 14}px`, title: n.key },
          twisty,
          n.label,
          n.text ? h('span', { class: 'mtb-muted' }, `  "${[...n.text].slice(0, 40).join('')}"`) : undefined,
        )
        twisty.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!kids.length) return
          if (open) {
            expanded.delete(n.key)
            collapsed.add(n.key)
          } else {
            collapsed.delete(n.key)
            expanded.add(n.key)
          }
          renderTree()
        })
        row.addEventListener('click', () => void onSelected(n.key))
        treeBox.append(row)
        if (open) for (const k of kids) add(k, depth + 1)
      }
      add(tree, 0)
    }

    const apply = (l: Listing | undefined): void => {
      if (!l) return
      combo.replaceChildren(...l.views.map((v) => h('option', { value: v.id }, v.label)))
      if (l.currentId !== undefined) combo.value = l.currentId
      tree = l.tree
      selectedKey = undefined
      selSeq++
      clearSelectionView()
      expanded.clear()
      collapsed.clear()
      renderTree()
      owner.textContent = l.owner || ' '
      setStatus(l.status.text, l.status.error)
      updateButtons()
    }

    const refresh = async (): Promise<void> => {
      loaded = true
      busy = true
      updateButtons()
      setStatus('Listing web views...')
      try {
        apply(await api.request<Listing | undefined>('refresh'))
      } catch (e) {
        setStatus((e as Error).message, true)
      } finally {
        busy = false
        updateButtons()
      }
    }

    const loadDom = async (): Promise<void> => {
      busy = true
      updateButtons()
      setStatus('Loading the DOM...')
      clearSelectionView()
      try {
        apply(await api.request<Listing | undefined>('loadDom', { id: combo.value }))
      } catch (e) {
        setStatus((e as Error).message, true)
      } finally {
        busy = false
        updateButtons()
      }
    }

    const showLocators = (s: { css: string; xpath: string }, cssText: string, xpText: string, cssCls: string, xpCls: string): void => {
      cssField.value = s.css
      xpathField.value = s.xpath
      cssMatch.textContent = cssText
      xpathMatch.textContent = xpText
      cssMatch.className = cssCls
      xpathMatch.className = xpCls
    }

    const onSelected = async (key: string): Promise<void> => {
      selectedKey = key
      renderTree()
      const my = ++selSeq
      clearSelectionView()
      try {
        const s = await api.request<Selection | undefined>('select', { key })
        if (!s || my !== selSeq) return
        liveSeq = s.seq
        showLocators(s, s.cssText, s.xpathText, matchClass(s.cssCount, undefined), matchClass(s.xpathCount, undefined))
        attrBox.replaceChildren(table(['Attribute', 'Value'], s.attrs.map(([k, v]) => [k, v])))
        currentSel = s
      } catch (e) {
        selectedNote.textContent = (e as Error).message
      }
    }
    let liveSeq = 0
    let currentSel: Selection | undefined

    api.on('live', (d) => {
      const l = d as Live
      if (l.seq !== liveSeq || !currentSel) return
      if (l.failed !== undefined) {
        selectedNote.textContent = l.failed
        return
      }
      showLocators(currentSel, l.cssText ?? '', l.xpathText ?? '', matchClass(l.cssCount, l.cssError), matchClass(l.xpathCount, l.xpathError))
      selectedNote.textContent = l.note ?? ' '
    })

    const runScript = async (): Promise<void> => {
      const text = code.value
      if (!text.trim()) return
      runBtn.disabled = true
      output.className = 'mtb-wv-out mtb-muted'
      output.textContent = 'Running...'
      try {
        const r = await api.request<EvalResult | undefined>('run', { code: text })
        if (!r) return
        output.className = `mtb-wv-out${r.error ? ' bad' : ''}`
        output.textContent = r.text
        output.scrollTop = 0
        if (r.notFound) setStatus('The web view is gone. Press Refresh.', true)
      } catch (e) {
        output.className = 'mtb-wv-out bad'
        output.textContent = (e as Error).message
      } finally {
        updateButtons()
      }
    }
    // Cmd on macOS, Ctrl elsewhere.
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void runScript()
      }
    })

    const locatorRow = (label: string, field: HTMLElement, match: HTMLElement, copy: () => string): HTMLElement =>
      h('div', { class: 'mtb-row' }, h('span', { class: 'mtb-wv-label' }, label), field, match, button('Copy', async () => {
        const text = copy()
        if (!text.trim()) return
        await copyText(text)
        setStatus(`Copied: ${text}`)
      }))

    root.append(
      h(
        'div',
        { class: 'mtb-wv' },
        h('div', { class: 'mtb-row' }, refreshBtn, combo, reloadBtn),
        status,
        owner,
        h(
          'div',
          { class: 'mtb-wv-main' },
          h('div', { class: 'mtb-wv-left' }, treeBox, showNonVisual),
          h(
            'div',
            { class: 'mtb-wv-right' },
            locatorRow('CSS', cssField, cssMatch, () => cssField.value),
            locatorRow('XPath', xpathField, xpathMatch, () => xpathField.value),
            selectedNote,
            attrBox,
            h('div', {}, 'JavaScript console (runs in the page: it can change the app; Ctrl/Cmd+Enter runs). Return primitives or JSON.stringify(value).'),
            code,
            h('div', { class: 'mtb-row' }, runBtn),
            output,
          ),
        ),
      ),
    )
    setStatus('Not connected')
    updateButtons()
    onShown = () => {
      if (!loaded) void refresh()
      else if (selectedKey !== undefined) void onSelected(selectedKey)
    }
  },

  shown() {
    onShown?.()
  },
}
