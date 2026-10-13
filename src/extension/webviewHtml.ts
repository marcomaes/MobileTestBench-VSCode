import { randomBytes } from 'node:crypto'

/** A fresh CSP nonce for one page load. */
export function newNonce(): string {
  return randomBytes(16).toString('base64')
}

/** The HTML shell of the viewer page: a strict CSP that allows only the one nonce'd script. */
export function viewerHtml(cspSource: string, scriptUri: string, nonce: string = newNonce()): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobile Test Bench</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`
}
