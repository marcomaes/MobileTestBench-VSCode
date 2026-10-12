// ported-from: ui/StackFrameOpener.kt
import * as vscode from 'vscode'
import { StackFrames, type StackFrame } from '../../core/logs/stackFrames'

/** Opens the source of a stack trace line in the workspace, by file name. */
export const StackFrameOpener = {
  /** The workspace file for [frame]: by file name, narrowed by the package path when several files have that name. */
  async find(frame: StackFrame): Promise<vscode.Uri | undefined> {
    const files = await vscode.workspace.findFiles(`**/${frame.file}`, '**/node_modules/**', 200)
    const chosen = StackFrames.choose(files.map((f) => f.fsPath), frame)
    return files.find((f) => f.fsPath === chosen)
  },

  /** Looks the file up and opens it at the line. Returns the status text for the log tab. */
  async open(frame: StackFrame): Promise<string> {
    const file = await StackFrameOpener.find(frame)
    if (!file) return `${frame.file} is not in this workspace (${frame.className ?? 'no class'})`
    const position = new vscode.Position(frame.line - 1, 0)
    await vscode.window.showTextDocument(file, { selection: new vscode.Range(position, position) })
    return `Opened ${vscode.workspace.asRelativePath(file)}:${frame.line}`
  },
}
