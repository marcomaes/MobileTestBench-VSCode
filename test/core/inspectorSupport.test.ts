// No Kotlin counterpart: covers the helpers that replace JVM facilities (java.util.regex, Formatter, the JDK XPath engine).
import { describe, expect, it } from 'vitest'
import { IllegalArgumentException } from '../../src/core/inspector/illegalArgumentException'
import { UiAutomatorParser } from '../../src/core/inspector/hierarchyParsers'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { formatFixed } from '../../src/core/javaFormat'
import { KRegex } from '../../src/core/javaRegex'
import { fixture } from '../helpers/fixtures'

const android = UiAutomatorParser.parse(fixture('android_login.xml'))
const count = (xpath: string) => LocatorQuery.find(xpath, android).length

describe('java regex translation', () => {
  it('handles inline flags, quoting, possessive quantifiers and POSIX classes', () => {
    expect(new KRegex('(?i)sign').containsMatchIn('SIGN IN')).toBe(true)
    expect(new KRegex('\\Qa.b\\E').matches('a.b')).toBe(true)
    expect(new KRegex('\\Qa.b\\E').matches('axb')).toBe(false)
    expect(new KRegex('a*+b').matches('aaab')).toBe(true)
    expect(new KRegex('(?>a+)b').matches('aab')).toBe(true)
    expect(new KRegex('\\p{Alpha}+').matches('abc')).toBe(true)
    expect(new KRegex('\\p{Alpha}+').matches('ab1')).toBe(false)
    expect(new KRegex('Sign').matches('Sign In')).toBe(false)
    expect(new KRegex('Sign.*').matches('Sign In')).toBe(true)
  })
})

describe('java formatting', () => {
  it('rounds half up on the shortest decimal form like java.util.Formatter', () => {
    expect(formatFixed(1.005, 2)).toBe('1.01')
    expect(formatFixed(2.68, 2)).toBe('2.68')
    expect(formatFixed(50.25, 1)).toBe('50.3')
    expect(formatFixed(9.96, 1)).toBe('10.0')
    expect(formatFixed(420 / 160, 2)).toBe('2.63')
  })
})

describe('xpath engine', () => {
  it('supports axes, unions, positions and functions', () => {
    expect(count('//*')).toBe(7)
    expect(count('//android.widget.Button | //android.widget.EditText')).toBe(3)
    expect(count('(//android.widget.Button)[last()]')).toBe(1)
    expect(count('//android.widget.Button[@text="Sign In"][2]')).toBe(1)
    expect(count('//*[contains(@resource-id, "email")]')).toBe(1)
    expect(count('//*[starts-with(@text, "Sign") and not(@enabled="false")]')).toBe(2)
    expect(count('//android.widget.EditText/ancestor::*')).toBe(3)
    expect(count('//android.widget.EditText/..')).toBe(1)
    expect(count('//android.widget.EditText/following-sibling::*')).toBeGreaterThan(0)
    expect(count('//*[string-length(@text) > 5]')).toBeGreaterThan(0)
  })

  it('rejects results that are not node sets and unknown functions', () => {
    expect(() => LocatorQuery.find('(//a)[count(//a)]/foo()', android)).toThrow(IllegalArgumentException)
    expect(() => LocatorQuery.find('(count(//*))', android)).toThrow(IllegalArgumentException)
    expect(() => LocatorQuery.find('(//a[bogus()])', android)).toThrow(IllegalArgumentException)
  })
})
