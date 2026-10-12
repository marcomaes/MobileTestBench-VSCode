// ported-from: test:ui/ShowLocatorActionTest.kt
// The registry and action registration tests are IntelliJ specific (project service, ActionManager); the text picking is ported.
import { describe, expect, it } from 'vitest'
import { EditorLocatorText } from '../../src/extension/editorLocatorText'

describe('ShowLocatorActionTest', () => {
  it('testTextIsSelectionOrCaretLine', () => {
    const doc = 'first()\nawait screen.getByTestId("a").tap()\nlast()\n'
    const caret = doc.indexOf('.tap()') + 6
    expect(EditorLocatorText.of(doc, caret)).toBe('await screen.getByTestId("a").tap()')
    expect(EditorLocatorText.of(doc, caret, doc.slice(0, 5))).toBe('first')
  })

  it('testEmptyDocument', () => {
    expect(EditorLocatorText.of('', 0)).toBe('')
  })

  it('a blank selection falls back to the caret line', () => {
    expect(EditorLocatorText.of('a\n  \nb', 0, '  ')).toBe('a')
  })

  it('first line, last line without a break, caret beyond the end and CRLF', () => {
    expect(EditorLocatorText.of('one\ntwo', 1)).toBe('one')
    expect(EditorLocatorText.of('one\ntwo', 100)).toBe('two')
    expect(EditorLocatorText.of('one\r\ntwo\r\nthree', 6)).toBe('two')
    expect(EditorLocatorText.of('one\ntwo', -5)).toBe('one')
  })

  it('a caret at the line break belongs to the line before it', () => {
    expect(EditorLocatorText.of('one\ntwo', 3)).toBe('one')
    expect(EditorLocatorText.of('one\ntwo', 4)).toBe('two')
  })
})
