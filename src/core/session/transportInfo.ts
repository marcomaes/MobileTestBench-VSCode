// ported-from: core/session/TransportInfo.kt

/** The transport a session uses plus, when it is not the preferred one, why a fallback happened. */
export interface TransportInfo {
  readonly name: string
  readonly fallbackReason?: string
}

const MAX_REASON = 300

/** First line of [text], cut to a sensible length. */
export function oneLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > MAX_REASON ? line.slice(0, MAX_REASON - 3) + '...' : line
}

/** Plain text, one line per fact, for a status bar tooltip. */
export function transportTooltip(info: TransportInfo): string {
  let s = `Transport: ${info.name}`
  const reason = info.fallbackReason?.trim()
  if (reason) s += `\nFallback: ${oneLine(reason)}`
  return s
}
