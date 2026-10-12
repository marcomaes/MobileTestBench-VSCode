// ported-from: ui/EditorInsert.kt
import * as vscode from 'vscode'

let lastEditor: vscode.TextEditor | undefined

/** Writes text at the caret of the editor that is open in the IDE. */
export const EditorInsert = {
  /**
   * A webview in front means there is no active text editor, so the last one that was active is remembered (call once on activation).
   */
  track(context: vscode.ExtensionContext): void {
    lastEditor = vscode.window.activeTextEditor
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) lastEditor = e
      }),
    )
  },

  /** Returns undefined on success, otherwise why nothing was inserted. */
  async insertAtCaret(text: string): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor ?? (lastEditor && vscode.window.visibleTextEditors.includes(lastEditor) ? lastEditor : vscode.window.visibleTextEditors[0])
    if (!editor) return 'No editor open to insert into'
    if (['output', 'debug', 'git', 'vscode-terminal'].includes(editor.document.uri.scheme)) return 'The editor is read-only'
    const ok = await editor.edit((b) => {
      for (const sel of editor.selections) b.replace(sel, text)
    })
    return ok ? undefined : 'The editor is read-only'
  },
}
