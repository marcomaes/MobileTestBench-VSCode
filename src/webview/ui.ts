// No Kotlin counterpart: tiny DOM helpers so every Device Tools tab looks the same (VS Code theme variables, no framework).

type Child = Node | string | number | false | null | undefined
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>

/** `h('button', { onclick: fn, title: 'x' }, 'Label')`. Attributes starting with `on` are event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = String(v)
    else if (k === 'value' || k === 'checked' || k === 'disabled') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c))
  return el
}

export const button = (label: string, onclick: () => void | Promise<void>, attrs: Attrs = {}): HTMLButtonElement =>
  h('button', { class: 'mtb-btn', ...attrs, onclick: () => void onclick() }, label)

export const row = (...children: Child[]): HTMLDivElement => h('div', { class: 'mtb-row' }, ...children)

export const field = (label: string, control: HTMLElement): HTMLLabelElement => h('label', { class: 'mtb-field' }, h('span', {}, label), control)

export const select = (options: Array<string | { value: string; label: string }>, value?: string, onchange?: (v: string) => void): HTMLSelectElement => {
  const el = h('select', { class: 'mtb-input' })
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o
    el.append(h('option', { value: opt.value }, opt.label))
  }
  if (value !== undefined) el.value = value
  if (onchange) el.addEventListener('change', () => onchange(el.value))
  return el
}

export const input = (value = '', attrs: Attrs = {}): HTMLInputElement => h('input', { class: 'mtb-input', type: 'text', value, ...attrs })

export const checkbox = (label: string, checked: boolean, onchange?: (v: boolean) => void): HTMLLabelElement => {
  const box = h('input', { type: 'checkbox', checked })
  if (onchange) box.addEventListener('change', () => onchange(box.checked))
  return h('label', { class: 'mtb-check' }, box, label)
}

/** A table from a header row and body rows. Cells may be strings or nodes. */
export function table(headers: string[], rows: Child[][], onRow?: (index: number, tr: HTMLTableRowElement) => void): HTMLTableElement {
  const t = h('table', { class: 'mtb-table' })
  t.createTHead().insertRow().append(...headers.map((x) => h('th', {}, x)))
  const body = t.createTBody()
  rows.forEach((cells, i) => {
    const tr = body.insertRow()
    for (const c of cells) tr.insertCell().append(c instanceof Node ? c : String(c ?? ''))
    if (onRow) onRow(i, tr)
    // A row hint is shown by our own tooltip: the native title tooltip does not reliably appear in the webview (see showTips).
    if (tr.title) {
      tr.dataset.tip = tr.title
      tr.removeAttribute('title')
    }
  })
  return t
}

/** A status line the tab updates: `msg.set('Saved')`, `msg.error('Failed')`. */
export function messageLine(): HTMLDivElement & { set(text: string): void; error(text: string): void } {
  const el = h('div', { class: 'mtb-msg' }) as HTMLDivElement & { set(text: string): void; error(text: string): void }
  el.set = (text) => {
    el.className = 'mtb-msg'
    el.textContent = text
  }
  el.error = (text) => {
    el.className = 'mtb-msg err'
    el.textContent = text
  }
  return el
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/** Runs [fn], shows its error in [msg] instead of throwing. */
export async function guarded(msg: { error(text: string): void }, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    msg.error(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Tooltips for elements with a data-tip attribute (one delegated listener for the page): shown 200 ms after the pointer rests on the
 * element, hidden when it leaves, a button goes down or the page scrolls.
 */
function showTips(): void {
  let tip: HTMLElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const hide = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    tip?.remove()
    tip = undefined
  }
  document.addEventListener('mouseover', (e) => {
    const target = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null
    hide()
    if (!target) return
    timer = setTimeout(() => {
      tip = h('div', { class: 'mtb-tip' }, target.dataset.tip)
      document.body.append(tip)
      tip.style.left = `${Math.max(0, Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 4))}px`
      tip.style.top = `${Math.max(0, Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 4))}px`
    }, 200)
  })
  document.addEventListener('mouseout', hide)
  document.addEventListener('mousedown', hide)
  document.addEventListener('scroll', hide, true)
}

/** Injects the shared tab CSS (and the tooltips) once. Called by the viewer; tools need not call it. */
export function injectToolStyles(): void {
  if (document.getElementById('mtb-tool-styles')) return
  showTips()
  const style = document.createElement('style')
  style.id = 'mtb-tool-styles'
  style.textContent = `
  .mtb-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  .mtb-field { display: inline-flex; gap: 4px; align-items: center; }
  .mtb-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; }
  .mtb-input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .mtb-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 10px; border-radius: 2px; cursor: pointer; }
  .mtb-btn:hover { background: var(--vscode-button-hoverBackground); }
  .mtb-btn:disabled { opacity: .5; cursor: default; }
  .mtb-check { display: inline-flex; gap: 4px; align-items: center; }
  .mtb-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .mtb-table th { text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding: 2px 6px; position: sticky; top: 0; background: var(--vscode-editor-background); }
  .mtb-table td { padding: 1px 6px; vertical-align: top; }
  .mtb-table tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .mtb-table tbody tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .mtb-msg { opacity: .8; min-height: 1.2em; } .mtb-msg.err { color: var(--vscode-errorForeground); opacity: 1; }
  .mtb-code { font-family: var(--vscode-editor-font-family); white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 4px 6px; }
  .mtb-muted { opacity: .7; }
  .mtb-tip { position: fixed; z-index: 30; max-width: 420px; pointer-events: none; padding: 3px 8px; font-size: 12px; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px rgba(0,0,0,.35); }
  `
  document.head.append(style)
}
