// ported-from: ui/ShowLocatorAction.kt
// EditorLocatorText: the text to look for a locator in. No vscode import: it takes the document text and offsets, so it is unit tested;
// the command `mobileTestBench.showLocator` (extension.ts) feeds it from the active editor.

export const EditorLocatorText = {
  /**
   * The selection, else the line with the caret. [selection] is the selected text (blank counts as none), [caretOffset] an offset
   * into [document] (clamped to it). An empty document gives an empty string.
   */
  of(document: string, caretOffset: number, selection?: string): string {
    if (selection !== undefined && selection.trim().length > 0) return selection
    if (document.length === 0) return ''
    const caret = Math.min(Math.max(caretOffset, 0), document.length)
    // The line the caret is on: an offset at a line break belongs to the line before it, like Document.getLineNumber.
    const start = Math.max(document.lastIndexOf('\n', caret - 1), document.lastIndexOf('\r', caret - 1)) + 1
    const endLf = document.indexOf('\n', caret)
    const endCr = document.indexOf('\r', caret)
    const ends = [endLf, endCr].filter((it) => it >= 0)
    const end = ends.length > 0 ? Math.min(...ends) : document.length
    return document.slice(start, end)
  },
}
