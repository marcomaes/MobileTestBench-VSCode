// ported-from: core/inspector/Locators.kt
import type { UiNode } from './uiNode'
import { LocatorQuery } from './locatorQuery'
import { ScopedLocators } from './scopedLocators'

export class LocatorSuggestion {
  constructor(
    readonly framework: string,
    readonly strategy: string,
    /** Text that is copied to the clipboard. */
    readonly expression: string,
    readonly matchCount: number,
    readonly isBest: boolean = false,
  ) {}

  get isUnique(): boolean {
    return this.matchCount === 1
  }

  /** Why this locator may be a poor choice, or undefined when nothing is wrong with it. */
  get hint(): string | undefined {
    if (this.matchCount === 0) return 'Matches nothing on the current screen.'
    if (this.matchCount > 1) return `Not unique: matches ${this.matchCount} elements.`
    if (this.strategy === 'xpath (absolute)') return 'Absolute path: breaks when the layout changes. Prefer an id.'
    if (this.strategy.startsWith('xpath') && this.strategy !== 'xpath (in parent)' && LocatorHints.isIndexBased(this.expression)) {
      return 'Index based XPath: breaks when elements are added, removed or reordered. Prefer an id or a unique attribute.'
    }
    if (this.framework === 'Mobilewright' && (this.strategy === 'label' || this.strategy === 'text')) {
      return 'Depends on the visible text, so it breaks with another language or changed copy. Prefer a test id.'
    }
    return undefined
  }

  /** Kotlin data class copy(). */
  copy(changes: Partial<Pick<LocatorSuggestion, 'framework' | 'strategy' | 'expression' | 'matchCount' | 'isBest'>>): LocatorSuggestion {
    return new LocatorSuggestion(
      changes.framework ?? this.framework,
      changes.strategy ?? this.strategy,
      changes.expression ?? this.expression,
      changes.matchCount ?? this.matchCount,
      changes.isBest ?? this.isBest,
    )
  }
}

const quoted = /"[^"]*"|'[^']*'/g
const indexBased = /\[\s*(\d+|last\(\s*\)(\s*-\s*\d+)?|position\(\s*\)[^\]]*)\s*\]|@index\s*=/

export const LocatorHints = {
  /** True when an XPath selects by position ([3], (//x)[2], [last()], [position()=2], [@index=1]). */
  isIndexBased(xpath: string): boolean {
    return indexBased.test(xpath.replace(quoted, '""'))
  },

  /**
   * The hint of [suggestion] plus, when it has a warning, the best other locator in [all] (already in
   * priority order) that is unique and has no warning; one of the same framework wins over another one.
   */
  hintWithAlternative(suggestion: LocatorSuggestion, all: readonly LocatorSuggestion[]): string | undefined {
    const hint = suggestion.hint
    if (hint === undefined) return undefined
    const better = all.filter((it) => it !== suggestion && it.isUnique && it.hint === undefined)
    const next = better.find((it) => it.framework === suggestion.framework) ?? better[0]
    if (next === undefined) return hint
    const where = next.framework === suggestion.framework ? next.strategy : `${next.framework} ${next.strategy}`
    return `${hint} Next best: ${where}, ${next.expression}`
  },
}

export type MobilewrightKind = 'TEST_ID' | 'ROLE' | 'LABEL' | 'TEXT'

export interface Derived {
  readonly kind: MobilewrightKind
  readonly value: string
  readonly name?: string
}

const derived = (kind: MobilewrightKind, value: string, name?: string): Derived => ({ kind, value, name })

/**
 * Mobilewright locator derivation, ported from Mobilewright Inspector's locator-derivation.js.
 * Priority: getByTestId > getByRole > getByLabel > getByText. If mobilewright changes its
 * matching rules, update [ROLE_TYPE_MAP] to stay in sync (checked against @mobilewright/core 0.0.57, `query-engine.js` ROLE_TYPE_MAP).
 */
export const MobilewrightLocators = {
  Kind: { TEST_ID: 'TEST_ID', ROLE: 'ROLE', LABEL: 'LABEL', TEXT: 'TEXT' } as const,

  ROLE_TYPE_MAP: new Map<string, readonly string[]>([
    ['button', ['button', 'imagebutton', 'floatingactionbutton', 'materialbutton', 'appcompatbutton']],
    ['textfield', ['textfield', 'securetextfield', 'searchfield', 'edittext', 'appcompatedittext', 'textinputedittext', 'reactedittext']],
    ['text', ['statictext', 'textview', 'appcompattextview', 'materialtextview', 'text', 'reacttextview']],
    ['image', ['image', 'imageview', 'appcompatimageview', 'shapeableimageview', 'reactimageview']],
    ['switch', ['switch', 'toggle', 'togglebutton']],
    ['checkbox', ['checkbox']],
    ['radio', ['radio', 'radiobutton', 'appcompatradiobutton']],
    ['slider', ['slider', 'seekbar']],
    ['list', ['table', 'collectionview', 'listview', 'recyclerview', 'scrollview', 'reactscrollview']],
    ['listitem', ['cell', 'linearlayout', 'relativelayout', 'other']],
    ['tab', ['tab', 'tabbar']],
    ['link', ['link']],
    ['header', ['navigationbar', 'toolbar', 'header']],
  ]),

  role(node: UiNode): string | undefined {
    const type = node.type.toLowerCase()
    if (type === 'reactviewgroup') {
      const clickable = node.attr('clickable') === 'true' || node.attr('accessible') === 'true'
      return clickable ? 'button' : undefined
    }
    for (const [role, types] of MobilewrightLocators.ROLE_TYPE_MAP) if (types.includes(type)) return role
    return undefined
  },

  /** All applicable locators in priority order (the first one is what mobilewright prefers). */
  deriveAll(node: UiNode): Derived[] {
    const result: Derived[] = []
    const testId = node.identifier ?? node.resourceId
    if (testId !== undefined) result.push(derived('TEST_ID', testId))
    const role = MobilewrightLocators.role(node)
    if (role !== undefined) result.push(derived('ROLE', role, node.label ?? node.text))
    if (node.label !== undefined) result.push(derived('LABEL', node.label))
    const text = node.text ?? node.value
    if (text !== undefined) result.push(derived('TEXT', text))
    return result
  },

  derive(node: UiNode): Derived | undefined {
    return MobilewrightLocators.deriveAll(node)[0]
  },

  matches(node: UiNode, locator: Derived): boolean {
    switch (locator.kind) {
      case 'TEST_ID':
        return (node.identifier ?? node.resourceId) === locator.value
      case 'ROLE':
        return MobilewrightLocators.role(node) === locator.value && (locator.name === undefined || (node.label ?? node.text) === locator.name)
      case 'LABEL':
        return node.label === locator.value
      case 'TEXT':
        return (node.text ?? node.value) === locator.value
    }
  },

  toCode(locator: Derived): string {
    const js = MobilewrightLocators.js
    switch (locator.kind) {
      case 'TEST_ID':
        return `screen.getByTestId(${js(locator.value)})`
      case 'ROLE':
        return locator.name !== undefined ? `screen.getByRole(${js(locator.value)}, { name: ${js(locator.name)} })` : `screen.getByRole(${js(locator.value)})`
      case 'LABEL':
        return `screen.getByLabel(${js(locator.value)})`
      case 'TEXT':
        return `screen.getByText(${js(locator.value)})`
    }
  },

  js(value: string): string {
    return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n') + "'"
  },
}

const kindWords = (kind: MobilewrightKind): string => kind.toLowerCase().replaceAll('_', ' ')

export const LocatorGenerator = {
  suggest(node: UiNode, root: UiNode): LocatorSuggestion[] {
    const all = [...root.walk()].filter((it) => !it.isRoot)
    const result: LocatorSuggestion[] = []

    MobilewrightLocators.deriveAll(node).forEach((d, index) => {
      result.push(
        new LocatorSuggestion(
          'Mobilewright',
          kindWords(d.kind),
          MobilewrightLocators.toCode(d),
          all.filter((it) => MobilewrightLocators.matches(it, d)).length,
          index === 0,
        ),
      )
    })

    // Not unique: offer the same locator inside a parent that makes it unique.
    const scoped = result[0] !== undefined && !result[0].isUnique ? ScopedLocators.forNode(node, root) : undefined
    if (scoped !== undefined) {
      result[0] = result[0].copy({ isBest: false })
      result.unshift(
        new LocatorSuggestion(
          'Mobilewright',
          kindWords(scoped.child.kind) + ' in parent',
          scoped.code(),
          ScopedLocators.within(all, scoped.parentNode, scoped.child).length,
          true,
        ),
      )
    }

    const appium = node.platform === 'ANDROID' ? LocatorGenerator.androidAppium(node, all) : LocatorGenerator.iosAppium(node, all)
    if (scoped !== undefined) {
      const xpath = LocatorGenerator.scopedXPath(node, scoped.parentNode, root)
      if (xpath !== undefined) {
        const found = appium.findIndex((it) => it.strategy === 'xpath')
        const at = found >= 0 ? found + 1 : appium.length
        appium.splice(at, 0, new LocatorSuggestion('Appium', 'xpath (in parent)', xpath, 1))
      }
    }
    result.push(...appium)
    return result
  },

  /**
   * The XPath of [node] inside [parent], defined by the parent's own attribute. Tried in order: the node as a
   * descendant of the parent, then as the nearest following or preceding sibling, then as the nearest following
   * or preceding element in document order (a flattened tree, where a card is not the parent of its button).
   * Only a form that finds exactly [node] is returned.
   */
  scopedXPath(node: UiNode, parent: UiNode, root: UiNode): string | undefined {
    const parentAttr = LocatorGenerator.identifyingAttribute(parent)
    if (parentAttr === undefined) return undefined
    const nodeAttr = LocatorGenerator.identifyingAttribute(node)
    if (nodeAttr === undefined) return undefined
    const from = `//${parent.rawType}[@${parentAttr[0]}=${LocatorGenerator.xpathLiteral(parentAttr[1])}]`
    const target = `${node.rawType}[@${nodeAttr[0]}=${LocatorGenerator.xpathLiteral(nodeAttr[1])}]`
    return [`${from}//${target}`, `${from}/following-sibling::${target}[1]`, `${from}/preceding-sibling::${target}[1]`, `${from}/following::${target}[1]`, `${from}/preceding::${target}[1]`].find((it) => {
      try {
        const found = LocatorQuery.find(it, root)
        return found.length === 1 && found[0] === node
      } catch {
        return false
      }
    })
  },

  identifyingAttribute(node: UiNode): [string, string] | undefined {
    const attrs = node.platform === 'ANDROID' ? ['resource-id', 'content-desc', 'text'] : ['name', 'label', 'value']
    for (const attr of attrs) {
      const v = node.attr(attr)
      if (v !== undefined) return [attr, v]
    }
    return undefined
  },

  androidAppium(node: UiNode, all: readonly UiNode[]): LocatorSuggestion[] {
    const out: LocatorSuggestion[] = []
    const id = node.resourceId
    if (id !== undefined) out.push(new LocatorSuggestion('Appium', 'id', id, all.filter((it) => it.resourceId === id).length))
    const desc = node.label
    if (desc !== undefined) out.push(new LocatorSuggestion('Appium', 'accessibility id', desc, all.filter((it) => it.label === desc).length))
    let attr: string | undefined
    let value: string | undefined
    if (node.resourceId !== undefined) [attr, value] = ['resource-id', node.resourceId]
    else if (node.label !== undefined) [attr, value] = ['content-desc', node.label]
    else if (node.text !== undefined) [attr, value] = ['text', node.text]
    if (attr !== undefined && value !== undefined) {
      const java = LocatorGenerator.java
      const selector =
        attr === 'resource-id'
          ? `new UiSelector().resourceId(${java(value)})`
          : attr === 'content-desc'
            ? `new UiSelector().description(${java(value)})`
            : `new UiSelector().className(${java(node.rawType)}).text(${java(value)})`
      const uiCount = attr === 'text' ? all.filter((it) => it.rawType === node.rawType && it.attr(attr!) === value).length : all.filter((it) => it.attr(attr!) === value).length
      out.push(new LocatorSuggestion('Appium', '-android uiautomator', selector, uiCount))
      out.push(new LocatorSuggestion('Appium', 'xpath', `//${node.rawType}[@${attr}=${LocatorGenerator.xpathLiteral(value)}]`, all.filter((it) => it.rawType === node.rawType && it.attr(attr!) === value).length))
    }
    out.push(new LocatorSuggestion('Appium', 'xpath (absolute)', node.absoluteXPath(), 1))
    return out
  },

  iosAppium(node: UiNode, all: readonly UiNode[]): LocatorSuggestion[] {
    const out: LocatorSuggestion[] = []
    const name = node.attr('name')
    if (name !== undefined) out.push(new LocatorSuggestion('Appium', 'accessibility id', name, all.filter((it) => it.attr('name') === name).length))
    let attr: string | undefined
    let value: string | undefined
    if (node.identifier !== undefined) [attr, value] = ['name', node.identifier]
    else if (node.label !== undefined) [attr, value] = ['label', node.label]
    else if (node.value !== undefined) [attr, value] = ['value', node.value]
    else if (name !== undefined) [attr, value] = ['name', name]
    if (attr !== undefined && value !== undefined) {
      const count = all.filter((it) => it.rawType === node.rawType && it.attr(attr!) === value).length
      const lit = LocatorGenerator.predicateLiteral
      out.push(new LocatorSuggestion('Appium', '-ios predicate string', `type == ${lit(node.rawType)} AND ${attr} == ${lit(value)}`, count))
      out.push(new LocatorSuggestion('Appium', '-ios class chain', `**/${node.rawType}[\`${attr} == ${lit(value)}\`]`, count))
      out.push(new LocatorSuggestion('Appium', 'xpath', `//${node.rawType}[@${attr}=${LocatorGenerator.xpathLiteral(value)}]`, count))
    }
    out.push(new LocatorSuggestion('Appium', 'xpath (absolute)', node.absoluteXPath(), 1))
    return out
  },

  java(value: string): string {
    return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
  },

  predicateLiteral(value: string): string {
    return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"
  },

  xpathLiteral(value: string): string {
    if (!value.includes('"')) return `"${value}"`
    if (!value.includes("'")) return `'${value}'`
    return 'concat(' + value.split('"').map((it) => `"${it}"`).join(`, '"', `) + ')'
  },
}
