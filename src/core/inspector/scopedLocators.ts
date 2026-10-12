// ported-from: core/inspector/ScopedLocators.kt
import { rectArea, rectContainsRect } from '../model'
import { MobilewrightLocators, type Derived } from './locators'
import type { UiNode } from './uiNode'

/**
 * A locator made unique by a parent (any element that encloses it): `screen.getByTestId('product-item-2').getByTestId('add-to-cart')` finds the
 * "add-to-cart" inside "product-item-2" only. Mobilewright scopes a chained locator to the bounds of the parent.
 */
export class Scoped {
  constructor(
    readonly parent: Derived,
    readonly child: Derived,
    readonly parentNode: UiNode,
  ) {}

  code(): string {
    return ScopedLocators.chain(this.parent, this.child)
  }
}

/** How many of the nearest enclosing elements are tried as a parent. */
const MAX_CANDIDATES = 20

export const ScopedLocators = {
  chain(parent: Derived, child: Derived): string {
    const childCode = MobilewrightLocators.toCode(child)
    return MobilewrightLocators.toCode(parent) + (childCode.startsWith('screen') ? childCode.slice('screen'.length) : childCode)
  },

  /** Elements matching [locator] that lie inside [parent] (the way a chained Mobilewright locator scopes). */
  within(all: readonly UiNode[], parent: UiNode, locator: Derived): UiNode[] {
    const box = parent.bounds
    if (!box) return []
    return all.filter((it) => it !== parent && MobilewrightLocators.matches(it, locator) && it.bounds !== undefined && rectContainsRect(box, it.bounds))
  },

  /**
   * The closest enclosing element that has a locator of its own that is unique on the screen, and inside which
   * one of [node]'s locators is unique. "Enclosing" is by bounds, like Mobilewright's scoping: in a flattened
   * tree (React Native) a card like `product-item-4` is a sibling of its button, not its parent, and still
   * works. An enclosing element with a unique test id wins over a nearer one that is only identified by its
   * label or text, which break with another language. Undefined when no parent helps.
   */
  forNode(node: UiNode, root: UiNode): Scoped | undefined {
    const box = node.bounds
    if (!box) return undefined
    const all = [...root.walk()].filter((it) => !it.isRoot)
    const ownLocators = MobilewrightLocators.deriveAll(node)
    if (ownLocators.length === 0) return undefined
    // sortedBy is stable in Kotlin and in Array.prototype.sort.
    const enclosing = all
      .filter((it) => it !== node && it.bounds !== undefined && rectContainsRect(it.bounds, box) && rectArea(it.bounds) > rectArea(box))
      .sort((a, b) => rectArea(a.bounds!) - rectArea(b.bounds!))
      .slice(0, MAX_CANDIDATES)
    let fallback: Scoped | undefined
    for (const candidate of enclosing) {
      const parentLocator = MobilewrightLocators.deriveAll(candidate).find((p) => all.filter((it) => MobilewrightLocators.matches(it, p)).length === 1)
      if (parentLocator === undefined) continue
      const child = ownLocators.find((c) => {
        const found = ScopedLocators.within(all, candidate, c)
        return found.length === 1 && found[0] === node
      })
      if (child === undefined) continue
      const scoped = new Scoped(parentLocator, child, candidate)
      if (parentLocator.kind === 'TEST_ID') return scoped
      if (fallback === undefined) fallback = scoped
    }
    return fallback
  },
}
