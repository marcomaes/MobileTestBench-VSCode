// ported-from: core/inspector/AccessibilityAudit.kt
import type { PixelReader } from '../image/pixels'
import { formatFixed } from '../javaFormat'
import type { Platform, Rect, Size } from '../model'
import { Contrast, ContrastSampler, DpConverter, type ContrastEstimate } from './contrast'
import type { UiNode } from './uiNode'

export interface Rule {
  readonly name: 'MISSING_NAME' | 'TARGET_BELOW_MINIMUM' | 'TARGET_BELOW_RECOMMENDED' | 'LOW_CONTRAST_HINT'
  readonly title: string
}

const rule = <N extends Rule['name']>(name: N, title: string): Rule & { name: N } => Object.freeze({ name, title })

export class AccessibilityIssue {
  static readonly Rule = {
    MISSING_NAME: rule('MISSING_NAME', 'Missing name'),
    TARGET_BELOW_MINIMUM: rule('TARGET_BELOW_MINIMUM', 'Target below minimum'),
    TARGET_BELOW_RECOMMENDED: rule('TARGET_BELOW_RECOMMENDED', 'Target below recommended'),
    LOW_CONTRAST_HINT: rule('LOW_CONTRAST_HINT', 'Low contrast hint'),
  } as const

  constructor(
    readonly node: UiNode,
    readonly rule: Rule,
    readonly message: string,
    /** The measured colors, only for [Rule.LOW_CONTRAST_HINT]. */
    readonly contrast?: ContrastEstimate,
  ) {}
}

/** Whether the contrast rule ran, for the status line of the Accessibility tab. */
export type ContrastStatus = 'OFF' | 'NO_FRAME' | 'ON'
export const ContrastStatus = { OFF: 'OFF', NO_FRAME: 'NO_FRAME', ON: 'ON' } as const

export class AuditResult {
  constructor(
    readonly issues: AccessibilityIssue[],
    readonly platform: Platform,
    readonly densityDpi: number | undefined,
    readonly contrast: ContrastStatus,
  ) {}

  /** One line saying what could and could not be checked. */
  get statusLine(): string {
    let size: string
    if (this.platform === 'IOS') size = 'Sizes in points'
    else if (this.densityDpi === undefined) size = 'Density unknown: Android size rules skipped'
    else size = `Density ${this.densityDpi} dpi (${formatFixed(this.densityDpi / 160.0, 2)}x)`
    const colors = this.contrast === 'ON' ? 'frame sampling on' : this.contrast === 'NO_FRAME' ? 'no frame: contrast skipped' : 'contrast hints off'
    return `${size} - ${colors}`
  }
}

const Rules = AccessibilityIssue.Rule
const EPS = 1e-6

const iosInteractive = new Set(['button', 'switch', 'slider', 'textfield', 'securetextfield', 'searchfield', 'link', 'tab'])
/** Custom controls whose own frame is the touch target. */
const iosSizeChecked = new Set(['button', 'tab'])
/** Containers whose frame, not their children's, is what a finger hits. */
const iosTargetContainers = new Set([...iosInteractive, 'cell'])
const iosTextTypes = new Set(['statictext', 'button', 'textfield', 'securetextfield', 'searchfield', 'link'])
/** Android controls that draw smaller than their touch area. */
const androidSmallDrawn = new Set(['switch', 'switchcompat', 'checkbox', 'radiobutton', 'seekbar', 'togglebutton', 'compoundbutton', 'spinner', 'materialswitch', 'appcompatcheckbox', 'appcompatradiobutton', 'appcompatseekbar', 'appcompatspinner', 'appcompattogglebutton'])

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim().length === 0

function ancestors(node: UiNode): UiNode[] {
  const out: UiNode[] = []
  for (let p = node.parent; p; p = p.parent) out.push(p)
  return out
}

/**
 * Cheap accessibility checks on a hierarchy, based on WCAG 2.2 (the current W3C Recommendation;
 * WCAG 3.0 is still a Working Draft). WCAG is written for the web, so a point/dp is treated as a CSS pixel.
 * Only visible, interactive elements are checked.
 *  - MISSING_NAME (SC 4.1.2 Name, Role, Value, level A): no label or text on the element or any
 *    descendant, so a screen reader has nothing to say.
 *  - TARGET_BELOW_MINIMUM (SC 2.5.8 Target Size (Minimum), level AA): smaller than 24 x 24, unless the
 *    spacing exception applies (a 24 diameter circle centered on the target touches no other target
 *    or undersized-target circle).
 *  - TARGET_BELOW_RECOMMENDED: smaller than 44 x 44 on iOS (Apple's guideline, WCAG 2.5.5 level AAA) or 48 x 48 dp
 *    on Android (Material guidance). Not an AA failure.
 *  - LOW_CONTRAST_HINT (SC 1.4.3, level AA, 4.5:1): a heuristic on the screen image, see [ContrastSampler].
 *
 * iOS bounds are points. Android bounds are pixels: the size rules need the screen density (`adb shell wm density`,
 * the hierarchy does not carry it) and are skipped without it. Android sizes are judged in dp, including the spacing circle.
 * The size rules only look at the outermost control: an element inside a clickable or checkable ancestor is part of that
 * target. Not size checked: inline text links (iOS Link, Android clickable TextView; SC 2.5.8 "Inline" exception),
 * switches, checkboxes, radio buttons, seek bars and spinners on the 48 dp rule (they draw smaller than their touch
 * area, which the dump does not show; the 24 rule still applies), disabled Android controls, Android system UI
 * (resource id `com.android.systemui:`), iOS elements inside a cell or control, and Android elements cut by the
 * screen edge (the visible part says nothing about the real size).
 *
 * Contrast: only visible, enabled elements that show text (Android `text`; iOS label or value of static text, buttons,
 * links and text fields). Large text (3:1) cannot be told from the dump, so 4.5:1 is used and the result is a hint.
 */
export const AccessibilityAudit = {
  MINIMUM_TARGET: 24,
  RECOMMENDED_TARGET: 44,
  RECOMMENDED_TARGET_ANDROID_DP: 48,
  CONTRAST_TARGET: 4.5,

  /** The sampled ratio is an estimate (anti-aliased text, scaling): only a clearly lower ratio is reported. */
  CONTRAST_MARGIN: 0.1,

  run(root: UiNode, densityDpi?: number, frame?: () => PixelReader | undefined, logical?: Size, contrast = true): AccessibilityIssue[] {
    return AccessibilityAudit.analyse(root, densityDpi, frame, logical, contrast).issues
  },

  /**
   * [densityDpi]: Android screen density, undefined when unknown. [frame] and [logical] (the size of the coordinate space of
   * the bounds): the screen image for the contrast rule, which is skipped without them or when [contrast] is false.
   */
  analyse(root: UiNode, densityDpi?: number, frame?: () => PixelReader | undefined, logical?: Size, contrast = true): AuditResult {
    const all = [...root.walk()].filter((it) => !it.isRoot && it.isVisible)
    const interactive = all.filter((it) => AccessibilityAudit.isInteractive(it))
    const dpi = densityDpi !== undefined && densityDpi > 0 ? densityDpi : undefined
    const targets = interactive.filter((it) => isTarget(it))
    const issues = interactive.flatMap((it) => issuesFor(it, targets, dpi, logical))
    let status: ContrastStatus = 'OFF'
    if (contrast) {
      const image = frame?.()
      if (image === undefined || logical === undefined || logical.width <= 0 || logical.height <= 0) {
        status = 'NO_FRAME'
      } else {
        status = 'ON'
        for (const node of all) {
          const issue = contrastIssue(node, image, logical)
          if (issue) issues.push(issue)
        }
      }
    }
    return new AuditResult(issues, root.platform, dpi, status)
  },

  /** Elements a user can act on: clickable/checkable on Android, control types on iOS. */
  isInteractive(node: UiNode): boolean {
    return node.platform === 'ANDROID' ? node.attr('clickable') === 'true' || node.attr('checkable') === 'true' : iosInteractive.has(node.type.toLowerCase())
  },
}

function isTarget(node: UiNode): boolean {
  return node.platform === 'IOS' ? isOutermost(node) : node.attr('enabled') !== 'false' && !isSystemUi(node) && isOutermost(node)
}

function issuesFor(node: UiNode, targets: UiNode[], dpi: number | undefined, logical: Size | undefined): AccessibilityIssue[] {
  const out: AccessibilityIssue[] = []
  if (!hasName(node)) {
    out.push(new AccessibilityIssue(node, Rules.MISSING_NAME, `No label or text: a screen reader cannot name this ${node.type} (WCAG 4.1.2, level A).`))
  }
  const b = node.bounds
  if (!b) return out
  const MINIMUM_TARGET = AccessibilityAudit.MINIMUM_TARGET
  const RECOMMENDED_TARGET = AccessibilityAudit.RECOMMENDED_TARGET
  const RECOMMENDED_TARGET_ANDROID_DP = AccessibilityAudit.RECOMMENDED_TARGET_ANDROID_DP
  if (node.platform === 'IOS') {
    if (!iosSizeChecked.has(node.type.toLowerCase()) || !isOutermost(node)) return out
    const belowMinimum = b.width < MINIMUM_TARGET || b.height < MINIMUM_TARGET
    if (belowMinimum && !hasSpacingException(node, b, targets, 1.0)) {
      out.push(new AccessibilityIssue(node, Rules.TARGET_BELOW_MINIMUM, `Touch target is ${b.width} x ${b.height} pt and crowded by other targets; WCAG 2.5.8 (AA) requires ${MINIMUM_TARGET} x ${MINIMUM_TARGET} or spacing.`))
    } else if (b.width < RECOMMENDED_TARGET || b.height < RECOMMENDED_TARGET) {
      out.push(new AccessibilityIssue(node, Rules.TARGET_BELOW_RECOMMENDED, `Touch target is ${b.width} x ${b.height} pt; Apple recommends ${RECOMMENDED_TARGET} x ${RECOMMENDED_TARGET} (WCAG 2.5.5, AAA).`))
    }
  } else {
    if (dpi === undefined || !isTarget(node) || isInlineLink(node)) return out
    const scale = dpi / 160.0
    const wDp = DpConverter.toDp(b.width, dpi)
    const hDp = DpConverter.toDp(b.height, dpi)
    if (isCutByScreen(b, logical, wDp, hDp)) return out
    const px = `${b.width} x ${b.height} px at ${dpi} dpi`
    const size = `${DpConverter.format(wDp)} x ${DpConverter.format(hDp)} dp`
    const belowMinimum = wDp < MINIMUM_TARGET - EPS || hDp < MINIMUM_TARGET - EPS
    if (belowMinimum && !hasSpacingException(node, b, targets, scale)) {
      out.push(new AccessibilityIssue(node, Rules.TARGET_BELOW_MINIMUM, `Touch target is ${size} (${px}) and crowded by other targets; WCAG 2.5.8 (AA) requires ${MINIMUM_TARGET} x ${MINIMUM_TARGET} dp or spacing.`))
    } else if (androidSmallDrawn.has(node.type.toLowerCase())) {
      // exempt from the 48 dp rule
    } else if (wDp < RECOMMENDED_TARGET_ANDROID_DP - EPS || hDp < RECOMMENDED_TARGET_ANDROID_DP - EPS) {
      out.push(new AccessibilityIssue(node, Rules.TARGET_BELOW_RECOMMENDED, `Touch target is ${size} (${px}); Material recommends ${RECOMMENDED_TARGET_ANDROID_DP} x ${RECOMMENDED_TARGET_ANDROID_DP} dp (guidance, not an AA failure).`))
    }
  }
  return out
}

/**
 * A control cut by the screen edge keeps a tiny positive height in the dump (a 6 px high "DATE" header at the
 * bottom edge): its visible size says nothing, so it is not judged. Needs the display size.
 */
function isCutByScreen(b: Rect, logical: Size | undefined, wDp: number, hDp: number): boolean {
  if (!logical || logical.width <= 0 || logical.height <= 0) return false
  const cutX = b.x < 0 || b.x + b.width >= logical.width
  const cutY = b.y < 0 || b.y + b.height >= logical.height
  const limit = AccessibilityAudit.RECOMMENDED_TARGET_ANDROID_DP
  return (cutX && wDp < limit) || (cutY && hDp < limit)
}

function contrastIssue(node: UiNode, frame: PixelReader, logical: Size): AccessibilityIssue | undefined {
  const b = node.bounds
  if (!b) return undefined
  if (!showsText(node)) return undefined
  const estimate = ContrastSampler.estimate(frame, logical, b)
  if (!estimate) return undefined
  if (estimate.ratio >= AccessibilityAudit.CONTRAST_TARGET - AccessibilityAudit.CONTRAST_MARGIN) return undefined
  const ratio = formatFixed(estimate.ratio, 2)
  return new AccessibilityIssue(
    node,
    Rules.LOW_CONTRAST_HINT,
    `Possible low contrast ${ratio}:1 (text ${Contrast.hex(estimate.foreground)} on ${Contrast.hex(estimate.background)}); ` +
      'WCAG 1.4.3 asks 4.5:1 (3:1 for large text, which cannot be told from the dump). Estimated from the screen image, treat as a hint.',
    estimate,
  )
}

/** Elements whose own text is drawn: Android `text`, iOS label or value of text-like types. Disabled ones are exempt (SC 1.4.3). */
function showsText(node: UiNode): boolean {
  return node.platform === 'ANDROID'
    ? node.attr('enabled') !== 'false' && !isSystemUi(node) && !isBlank(node.text)
    : node.attr('enabled') !== 'false' && iosTextTypes.has(node.type.toLowerCase()) && !isBlank(node.label ?? node.value)
}

function isSystemUi(node: UiNode): boolean {
  return node.resourceId?.startsWith('com.android.systemui:') === true
}

/** A clickable TextView is a link in running text (SC 2.5.8 "Inline" exception). */
function isInlineLink(node: UiNode): boolean {
  return node.type.endsWith('TextView') && node.type.toLowerCase() !== 'checkedtextview'
}

/**
 * SC 2.5.8 "Spacing": a circle of [MINIMUM_TARGET] diameter centered on the undersized target must not
 * intersect another target, nor the circle of another undersized target. [scale] is pixels per unit (dp on
 * Android: dpi / 160, 1 on iOS), so the circle is 24 dp wide, not 24 px.
 */
function hasSpacingException(node: UiNode, bounds: Rect, targets: UiNode[], scale: number): boolean {
  const MINIMUM_TARGET = AccessibilityAudit.MINIMUM_TARGET
  const radius = MINIMUM_TARGET / 2.0
  const cx = (bounds.x + bounds.width / 2.0) / scale
  const cy = (bounds.y + bounds.height / 2.0) / scale
  return !targets
    .filter((it) => it !== node)
    .some((other) => {
      const ob = other.bounds
      if (!ob) return false
      const ox = ob.x / scale
      const oy = ob.y / scale
      const ow = ob.width / scale
      const oh = ob.height / scale
      const undersized = ow < MINIMUM_TARGET - EPS || oh < MINIMUM_TARGET - EPS
      if (undersized) return Math.hypot(cx - (ox + ow / 2.0), cy - (oy + oh / 2.0)) < MINIMUM_TARGET
      // Distance from the circle center to the rectangle.
      const dx = Math.max(ox - cx, 0.0, cx - (ox + ow))
      const dy = Math.max(oy - cy, 0.0, cy - (oy + oh))
      return Math.hypot(dx, dy) < radius
    })
}

/** iOS: not inside a cell or control. Android: no clickable or checkable ancestor. */
function isOutermost(node: UiNode): boolean {
  return node.platform === 'IOS' ? !ancestors(node).some((it) => iosTargetContainers.has(it.type.toLowerCase())) : !ancestors(node).some((it) => AccessibilityAudit.isInteractive(it))
}

/** A control is named by its own label/text or by a label inside it, e.g. a button wrapping a text view. */
function hasName(node: UiNode): boolean {
  for (const it of node.walk()) if (!isBlank(it.label ?? it.text ?? it.value)) return true
  return false
}
