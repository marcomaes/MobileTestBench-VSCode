// ported-from: core/inspector/HierarchyFilter.kt
import { AccessibilityAudit } from './accessibilityAudit'
import { AttributeMatcher, FilterQuery, type FilterGroup, type InvalidTerm } from './filterQuery'
import type { UiNode } from './uiNode'

export interface FilterCriteriaOptions {
  /**
   * The filter field: case insensitive free text searched in type, id, label, text and value,
   * mixed with attribute terms (`clickable=true class~Button`, see [FilterQuery]). Blank matches everything.
   */
  readonly text?: string
  readonly visibleOnly?: boolean
  readonly interactiveOnly?: boolean
}

/** Narrows the element tree of the inspector. */
export class FilterCriteria {
  readonly text: string
  readonly visibleOnly: boolean
  readonly interactiveOnly: boolean
  readonly query: FilterQuery

  constructor(options: FilterCriteriaOptions = {}) {
    this.text = options.text ?? ''
    this.visibleOnly = options.visibleOnly ?? false
    this.interactiveOnly = options.interactiveOnly ?? false
    this.query = FilterQuery.parse(this.text)
  }

  /** Terms of [text] that were not understood; they do not narrow the tree. */
  get invalidTerms(): readonly InvalidTerm[] {
    return this.query.invalid
  }

  get isEmpty(): boolean {
    return this.query.isEmpty && !this.visibleOnly && !this.interactiveOnly
  }
}

const containsIgnoreCase = (a: string, b: string): boolean => a.toLowerCase().includes(b.toLowerCase())

export const HierarchyFilter = {
  matches(node: UiNode, criteria: FilterCriteria): boolean {
    if (criteria.visibleOnly && !node.isVisible) return false
    if (criteria.interactiveOnly && !AccessibilityAudit.isInteractive(node)) return false
    const groups = criteria.query.groups
    return groups.length === 0 || groups.some((it) => HierarchyFilter.matchesGroup(node, it))
  },

  /** Whether [node] satisfies every part of one `OR` group (Kotlin overload `matches(node, group)`). */
  matchesGroup(node: UiNode, group: FilterGroup): boolean {
    if (group.terms.some((it) => !AttributeMatcher.matches(node, it))) return false
    if (group.notTerms.some((it) => AttributeMatcher.matches(node, it))) return false
    const fields = [node.rawType, node.type, node.identifier, node.resourceId, node.label, node.text, node.value].filter((it): it is string => it !== undefined)
    if (group.freeText.length > 0 && !fields.some((it) => containsIgnoreCase(it, group.freeText))) return false
    if (group.notFree.some((word) => fields.some((it) => containsIgnoreCase(it, word)))) return false
    if (group.regexes.some((re) => !fields.some((it) => re.containsMatchIn(it)))) return false
    if (group.notRegexes.some((re) => fields.some((it) => re.containsMatchIn(it)))) return false
    return true
  },

  /**
   * The nodes to show: every matching node plus all its ancestors, so a match keeps its place in the tree.
   * Returns undefined when the criteria are empty (show everything).
   */
  visibleNodes(root: UiNode, criteria: FilterCriteria): Set<UiNode> | undefined {
    if (criteria.isEmpty) return undefined
    const keep = new Set<UiNode>()
    for (const match of root.walk()) {
      if (match.isRoot || !HierarchyFilter.matches(match, criteria)) continue
      for (let n: UiNode | undefined = match; n && !keep.has(n); n = n.parent) keep.add(n)
    }
    return keep
  },
}
