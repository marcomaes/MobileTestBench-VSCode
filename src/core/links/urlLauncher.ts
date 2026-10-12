// ported-from: core/links/UrlLauncher.kt

/** The cleaned value, or an error text. A value must be one line without whitespace and start with a scheme (`https:`, `myapp:`). */
export type Validation = { type: 'Ok'; url: string } | { type: 'Invalid'; reason: string }

const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:.*$/s

/** Pure helpers for the URL / deep link launcher: validation, the mobilecli arguments, error wording and the history list. */
export const UrlLauncher = {
  MAX_HISTORY: 20,

  validate(input: string): Validation {
    const value = input.trim()
    if (value.length === 0) return { type: 'Invalid', reason: 'Enter a URL or deep link' }
    if (/\s/.test(value)) {
      return { type: 'Invalid', reason: /[\n\r]/.test(value) ? 'Use a single line' : 'A URL cannot contain spaces (percent-encode them as %20)' }
    }
    if (!scheme.test(value)) return { type: 'Invalid', reason: 'Start with a scheme, for example https:// or myapp://' }
    return { type: 'Ok', url: value }
  },

  /** Arguments for mobilecli (the device is added by the caller). */
  args: (url: string): string[] => ['url', url],

  /**
   * A short, readable reason from mobilecli's error text. Android errors are multi-line and keep their own `Error:` line;
   * iOS errors are only "exit status N" (115: no handler, 206: malformed).
   */
  friendlyError(raw: string): string {
    const lines = raw
      .split(/\r\n|\n|\r/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const errorLine = lines.find((l) => l.startsWith('Error:'))
    if (errorLine !== undefined) return errorLine.slice('Error:'.length).trim()
    const status = /exit status (\d+)/.exec(raw)?.[1]
    if (lines.length <= 1 || lines[0].includes('exit status')) {
      if (status === '115') return 'No app on the device handles this URL scheme'
      if (status === '206') return 'Not a valid URL (is the scheme missing?)'
    }
    return lines[0] ?? 'Could not open the URL'
  },

  /** [history] with [url] moved to the front: distinct, newest first, at most [MAX_HISTORY]. */
  addToHistory(history: string[], url: string): string[] {
    return [url, ...history.filter((h) => h !== url)].slice(0, UrlLauncher.MAX_HISTORY)
  },
}
