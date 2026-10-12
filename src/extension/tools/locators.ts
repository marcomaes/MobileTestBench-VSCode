// ported-from: ui/InspectorPanel.kt
// ported-from: ui/PageObjectDialog.kt
// Host half of the Locators tab. The webview half computes what follows the selection (locator suggestions, the locator query, the
// element filter); this half does what needs the host: the accessibility audit with contrast sampling on the frame the hierarchy was
// captured with and the device density, the Generate Page Object candidates and code, Save, Insert at Caret and the settings.
import { Buffer } from 'node:buffer'
import * as vscode from 'vscode'
import { decodeImage } from '../../core/image/pixels'
import { fromDto } from '../serialize'
import { EditorInsert } from '../editorInsert'
import { generatePageObject, languageOf, optionsOf, PageObjectSource, runAudit, type PageObjectRequest } from '../locatorsModel'
import type { NodeDto } from '../../protocol'
import type { ToolHost } from './toolHost'
import { viewerState } from './viewerState'

interface State {
  source?: PageObjectSource
}

const SETTINGS = ['locatorLanguage', 'locatorWholeLine', 'contrastHints', 'pageObjectLanguage', 'pageObjectLocatorStyle', 'pageObjectBaseClass', 'pageObjectGenerateBaseClass', 'pageObjectSortByName'] as const

export const locatorsHost: ToolHost = {
  id: 'locators',
  title: 'Locators',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    const state = viewerState<State>(ctx, 'locators', () => ({}))
    switch (method) {
      case 'state': {
        const s = ctx.settings()
        return Object.fromEntries(SETTINGS.map((k) => [k, s[k]]))
      }
      case 'set': {
        const key = String(p.key) as (typeof SETTINGS)[number]
        if (!SETTINGS.includes(key)) throw new Error(`Locators: unknown setting ${key}`)
        await ctx.updateSetting(key, p.value as never)
        return undefined
      }
      case 'audit': {
        const root = fromDto(p.root as NodeDto)
        const session = ctx.session()
        const contrast = p.contrast === true
        // The audit samples pixels of the frame that was current when the hierarchy was captured.
        let frame
        if (contrast && typeof p.frameBase64 === 'string') {
          try {
            frame = decodeImage(Buffer.from(p.frameBase64, 'base64'))
          } catch {
            frame = undefined
          }
        }
        const dpi = root.platform === 'ANDROID' ? await session?.density().catch(() => undefined) : undefined
        return runAudit(root, dpi, frame, session?.logicalSize(), contrast)
      }
      case 'insert':
        return (await EditorInsert.insertAtCaret(String(p.text))) ?? ''
      case 'pageObject.open': {
        state.source = new PageObjectSource(fromDto(p.root as NodeDto))
        const s = ctx.settings()
        return {
          mobilewright: state.source.rows(false),
          appium: state.source.rows(true),
          language: languageOf(s.pageObjectLanguage).name,
          style: s.pageObjectLocatorStyle,
          baseClass: s.pageObjectBaseClass.trim() === '' ? 'BasePage' : s.pageObjectBaseClass,
          generateBase: s.pageObjectGenerateBaseClass,
          sortByName: s.pageObjectSortByName,
        }
      }
      case 'pageObject.generate': {
        if (!state.source) throw new Error('Open the page object dialog first')
        const r = p.request as PageObjectRequest
        if (p.persist === true) {
          const o = optionsOf(r)
          await ctx.updateSetting('pageObjectLanguage', o.language.name)
          await ctx.updateSetting('pageObjectLocatorStyle', o.style?.name ?? r.style)
          await ctx.updateSetting('pageObjectBaseClass', o.baseClass ?? 'BasePage')
          await ctx.updateSetting('pageObjectGenerateBaseClass', r.generateBase)
          await ctx.updateSetting('pageObjectSortByName', r.sortByName)
        }
        return generatePageObject(state.source, r)
      }
      case 'pageObject.save': {
        const name = String(p.fileName)
        const language = languageOf(String(p.language))
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri
        const target = await vscode.window.showSaveDialog({
          title: 'Save Page Object',
          defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
          filters: { [language.label]: [language.extension] },
        })
        if (!target) return ''
        try {
          await vscode.workspace.fs.writeFile(target, Buffer.from(String(p.text), 'utf8'))
          return `Saved to ${target.fsPath}`
        } catch (e) {
          return `Could not save: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      default:
        throw new Error(`Locators: unknown method ${method}`)
    }
  },
}
