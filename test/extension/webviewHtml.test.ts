import { describe, expect, it } from 'vitest'
import { newNonce, viewerHtml } from '../../src/extension/webviewHtml'

describe('viewerHtml', () => {
  it('nonces are unique, long and safe inside an HTML attribute and a CSP', () => {
    const nonces = new Set(Array.from({ length: 200 }, newNonce))
    expect(nonces.size).toBe(200)
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })

  it('allows only the one nonce script, no inline script and no network', () => {
    const html = viewerHtml('vscode-resource:', 'vscode-resource:/dist/webview/mirror.js', 'abc')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-abc'")
    expect(html).toContain('<script nonce="abc" src="vscode-resource:/dist/webview/mirror.js"></script>')
    expect(html).not.toContain("'unsafe-eval'")
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('uses a fresh nonce per page when none is given', () => {
    const nonceOf = (h: string) => /script nonce="([^"]+)"/.exec(h)![1]
    expect(nonceOf(viewerHtml('c', 's'))).not.toBe(nonceOf(viewerHtml('c', 's')))
  })
})
