// ported-from: core/inspector/UiNode.kt
import { rectArea, rectContainsPoint, type Platform, type Rect } from '../model'

/**
 * One element of the UI hierarchy. The normalized accessors (type, label, identifier, resourceId, text, value)
 * mirror mobilewright's ViewNode so the locator logic matches what Mobilewright Inspector shows.
 */
export class UiNode {
  private readonly _children: UiNode[] = []
  private _parent: UiNode | undefined

  constructor(
    readonly platform: Platform,
    /** Tag as used in XPath: "android.widget.Button" or "XCUIElementTypeButton". */
    readonly rawType: string,
    readonly attributes: Readonly<Record<string, string>>,
    readonly bounds?: Rect,
  ) {}

  get children(): readonly UiNode[] {
    return this._children
  }

  get parent(): UiNode | undefined {
    return this._parent
  }

  get isRoot(): boolean {
    return this._parent === undefined
  }

  addChild(child: UiNode): void {
    child._parent = this
    this._children.push(child)
  }

  /** Short type: "Button", "TextView", "StaticText". */
  get type(): string {
    return this.platform === 'ANDROID' ? this.rawType.slice(this.rawType.lastIndexOf('.') + 1) : this.rawType.replace(/^XCUIElementType/, '')
  }

  get label(): string | undefined {
    return this.attr(this.platform === 'ANDROID' ? 'content-desc' : 'label')
  }

  /**
   * iOS accessibilityIdentifier. XCUITest reports the label as "name" when no identifier is set, so name is only
   * treated as an identifier when it differs from the label.
   */
  get identifier(): string | undefined {
    if (this.platform === 'ANDROID') return undefined
    const name = this.attr('name')
    return name !== undefined && name !== this.attr('label') ? name : undefined
  }

  get resourceId(): string | undefined {
    return this.platform === 'ANDROID' ? this.attr('resource-id') : undefined
  }

  get text(): string | undefined {
    return this.platform === 'ANDROID' ? this.attr('text') : undefined
  }

  get value(): string | undefined {
    return this.platform === 'IOS' ? this.attr('value') : undefined
  }

  get isVisible(): boolean {
    const b = this.bounds
    if (!b || b.width <= 0 || b.height <= 0) return false
    return this.platform === 'ANDROID'
      ? this.attr('visible-to-user') !== 'false' && this.attr('visible') !== 'false'
      : this.attr('visible') !== 'false'
  }

  /** The attribute, or undefined when missing or empty. */
  attr(name: string): string | undefined {
    const v = this.attributes[name]
    return v === undefined || v === '' ? undefined : v
  }

  *walk(): Generator<UiNode> {
    yield this
    for (const child of this._children) yield* child.walk()
  }

  get depth(): number {
    let d = 0
    for (let p = this._parent; p; p = p._parent) d++
    return d
  }

  /** 1-based position among siblings with the same tag, as used in XPath. */
  xpathIndex(): number {
    const siblings = this._parent?._children
    if (!siblings) return 1
    return siblings.filter((s) => s.rawType === this.rawType).indexOf(this) + 1
  }

  absoluteXPath(): string {
    const chain: UiNode[] = []
    for (let n: UiNode | undefined = this; n; n = n._parent) chain.unshift(n)
    return chain.map((n) => (n.isRoot ? `/${n.rawType}` : `/${n.rawType}[${n.xpathIndex()}]`)).join('')
  }

  /** Text shown in the inspector tree. */
  displayLabel(): string {
    let s = this.type
    const caption = this.label ?? this.text ?? this.value
    if (caption !== undefined) s += `  "${[...caption].slice(0, 40).join('')}"`
    const rid = this.resourceId
    const id = this.identifier ?? (rid !== undefined ? rid.slice(rid.indexOf(':id/') + (rid.includes(':id/') ? 4 : 0)) : undefined)
    if (id !== undefined) s += `  #${id}`
    return s
  }

  toString(): string {
    return this.displayLabel()
  }
}

export const HierarchyQueries = {
  /** The smallest visible node containing the point; on ties the deepest one wins. */
  deepestAt(root: UiNode, x: number, y: number): UiNode | undefined {
    let best: UiNode | undefined
    for (const node of root.walk()) {
      if (node.isRoot) continue
      const b = node.bounds
      if (!b || !node.isVisible || !rectContainsPoint(b, x, y)) continue
      if (!best || rectArea(b) <= rectArea(best.bounds!)) best = node
    }
    return best
  },
}
