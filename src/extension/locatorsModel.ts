// ported-from: ui/InspectorPanel.kt
// ported-from: ui/PageObjectDialog.kt
// The pure parts of the Locators tab host: the accessibility audit as rows for the webview, and the Generate Page Object dialog
// (candidate rows, the options with their identifier rules, the generated code). No vscode import, so it is unit tested.
import { AccessibilityAudit, type AuditResult } from '../core/inspector/accessibilityAudit'
import type { PixelReader } from '../core/image/pixels'
import type { Size } from '../core/model'
import type { UiNode } from '../core/inspector/uiNode'
import {
  LocatorStyle,
  PageCandidate,
  PageElement,
  PageLocator,
  PageObjectCandidates,
  PageObjectGenerator,
  PageObjectLanguage,
  type PageObjectOptions,
} from '../core/pageobject/pageObject'

export interface IssueRow {
  /** Position of the element in a depth first walk of the hierarchy (the webview rebuilds the same order). */
  index: number
  rule: string
  title: string
  message: string
  elementLabel: string
}

export interface AuditDto {
  statusLine: string
  issues: IssueRow[]
}

/** Kotlin `runAudit` without the threading: the audit as plain rows. */
export function runAudit(root: UiNode, densityDpi: number | undefined, frame: PixelReader | undefined, logical: Size | undefined, contrast: boolean): AuditDto {
  const result: AuditResult = AccessibilityAudit.analyse(root, densityDpi, () => frame, logical, contrast)
  const index = new Map<UiNode, number>()
  for (const n of root.walk()) index.set(n, index.size)
  return {
    statusLine: result.statusLine,
    issues: result.issues.map((it) => ({ index: index.get(it.node) ?? -1, rule: it.rule.name, title: it.rule.title, message: it.message, elementLabel: it.node.displayLabel() })),
  }
}

export interface CandidateRow {
  index: number
  name: string
  typeName: string
  /** Text of the locator, undefined when the element has no unique one ("no unique locator"). */
  locator: string | undefined
  selectedByDefault: boolean
}

/** The text of the Locator column of the dialog. */
export function locatorText(l: PageLocator | undefined): string | undefined {
  if (l === undefined) return undefined
  return l instanceof PageLocator.Mobilewright ? l.expression : `${l.strategy.toLowerCase().replaceAll('_', ' ')}: ${l.value}`
}

/** What `generatePageObject` computes in the background: the candidates for both frameworks. */
export class PageObjectSource {
  readonly mobilewright: PageCandidate[]
  readonly appium: PageCandidate[]
  private readonly order: UiNode[]

  constructor(root: UiNode) {
    this.mobilewright = PageObjectCandidates.find(root, false)
    this.appium = PageObjectCandidates.find(root, true)
    this.order = [...root.walk()]
  }

  rows(appium: boolean): CandidateRow[] {
    return (appium ? this.appium : this.mobilewright).map((c) => ({
      index: this.order.indexOf(c.node),
      name: c.suggestedName,
      typeName: c.typeName,
      locator: locatorText(c.locator),
      selectedByDefault: c.selectedByDefault && c.locator !== undefined,
    }))
  }

  candidate(appium: boolean, index: number): PageCandidate | undefined {
    const node = this.order[index]
    return (appium ? this.appium : this.mobilewright).find((c) => c.node === node)
  }
}

export interface PageObjectRequest {
  appium: boolean
  rows: Array<{ index: number; name: string; selected: boolean }>
  className: string
  language: string
  style: string
  baseClass: string
  generateBase: boolean
  sortByName: boolean
}

/** Letters, digits and underscores of [text], or [fallback] when none are left. */
export const identifier = (text: string, fallback: string): string => text.replace(/[^\p{L}\p{N}_]/gu, '') || fallback

export function languageOf(name: string | undefined): PageObjectLanguage {
  return PageObjectLanguage.entries.find((it) => it.name === name) ?? PageObjectLanguage.MOBILEWRIGHT_TS
}

export function styleOf(name: string | undefined): LocatorStyle {
  return LocatorStyle.entries.find((it) => it.name === name) ?? LocatorStyle.BASE_CLASS_FIELDS
}

export function optionsOf(r: Pick<PageObjectRequest, 'className' | 'language' | 'style' | 'baseClass' | 'sortByName'>): PageObjectOptions {
  return {
    className: identifier(r.className, 'ScreenPage'),
    language: languageOf(r.language),
    style: styleOf(r.style),
    baseClass: identifier(r.baseClass, 'BasePage'),
    sortByName: r.sortByName,
  }
}

export interface GeneratedPageObject {
  page: string
  /** The base class code, undefined when none is generated (style without base class, or the box is off). */
  base: string | undefined
  count: number
  /** Candidates without a unique locator (not offered). */
  noLocator: number
  status: string
  pageFileName: string
  baseFileName: string
}

/** Kotlin `optionsChanged`: the code for the ticked elements and the status line. */
export function generatePageObject(source: PageObjectSource, r: PageObjectRequest): GeneratedPageObject {
  const o = optionsOf(r)
  const elements = r.rows.flatMap((row) => {
    const c = source.candidate(r.appium, row.index)
    return row.selected && c?.locator !== undefined && row.name.trim() !== '' ? [new PageElement(row.name, c.actions, c.locator)] : []
  })
  const showBase = (o.style?.usesBaseClass ?? true) && r.generateBase
  const noLocator = (r.appium ? source.appium : source.mobilewright).filter((c) => c.locator === undefined).length
  return {
    page: elements.length === 0 ? '// Tick the elements to include.' : PageObjectGenerator.generate(elements, o),
    base: showBase ? PageObjectGenerator.generateBaseClass(o) : undefined,
    count: elements.length,
    noLocator,
    status: `${elements.length} elements` + (noLocator > 0 ? `, ${noLocator} without a unique locator are not offered` : ''),
    pageFileName: PageObjectGenerator.fileName(o.language, o.className),
    baseFileName: PageObjectGenerator.fileName(o.language, o.baseClass ?? 'BasePage'),
  }
}
