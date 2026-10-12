// ported-from: test:core/UrlLauncherTest.kt
import { describe, expect, it } from 'vitest'
import { UrlLauncher } from '../../src/core/links/urlLauncher'
import { fixture } from '../helpers/fixtures'

// The fixture holds raw line breaks inside the string (Gson reads that leniently, JSON.parse does not): escape them first.
const errorOf = (name: string): string => JSON.parse(fixture(name).trim().replace(/\r?\n/g, '\\n')).error

describe('UrlLauncherTest', () => {
  it('valid urls are trimmed', () => {
    expect(UrlLauncher.validate('  https://example.com/a?x=1&y=2 \n')).toEqual({ type: 'Ok', url: 'https://example.com/a?x=1&y=2' })
    expect(UrlLauncher.validate('myapp://open/42')).toEqual({ type: 'Ok', url: 'myapp://open/42' })
    expect(UrlLauncher.validate('tel:123')).toEqual({ type: 'Ok', url: 'tel:123' })
  })

  it('invalid values are rejected with a reason', () => {
    const reason = (v: string) => {
      const r = UrlLauncher.validate(v)
      return r.type === 'Invalid' ? r.reason : ''
    }
    expect(UrlLauncher.validate('   ').type).toBe('Invalid')
    expect(reason('not a url')).toContain('spaces')
    expect(reason('a://b\nc://d')).toContain('single line')
    expect(reason('foo')).toContain('scheme')
    expect(UrlLauncher.validate('1http://x').type).toBe('Invalid')
  })

  it('args', () => {
    expect(UrlLauncher.args('myapp://x')).toEqual(['url', 'myapp://x'])
  })

  it('android error shows the Error line', () => {
    expect(UrlLauncher.friendlyError(errorOf('mobilecli-url-error-android.json'))).toBe(
      'Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=settings:///... flg=0x10000000 xflg=0x4 }',
    )
  })

  it('ios exit statuses are explained', () => {
    expect(UrlLauncher.friendlyError(errorOf('mobilecli-url-error-ios-115.json'))).toBe('No app on the device handles this URL scheme')
    expect(UrlLauncher.friendlyError(errorOf('mobilecli-url-error-ios-206.json'))).toBe('Not a valid URL (is the scheme missing?)')
    expect(UrlLauncher.friendlyError('')).toBe('Could not open the URL')
    expect(UrlLauncher.friendlyError('device offline')).toBe('device offline')
  })

  it('history is distinct newest first and capped', () => {
    expect(UrlLauncher.addToHistory(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
    expect(UrlLauncher.addToHistory(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const full = Array.from({ length: 20 }, (_, i) => `s${i + 1}://x`)
    const next = UrlLauncher.addToHistory(full, 'new://x')
    expect(next).toHaveLength(20)
    expect(next[0]).toBe('new://x')
    expect(next[next.length - 1]).toBe('s19://x')
    expect(UrlLauncher.addToHistory(full, 's5://x')).toEqual(['s5://x', ...full.filter((x) => x !== 's5://x')])
  })
})
