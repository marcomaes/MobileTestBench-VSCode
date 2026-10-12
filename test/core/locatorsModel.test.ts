// ported-from: test:ui/ReplayUiSmokeTest.kt
// The pure parts of the Locators tab host: audit rows and the Generate Page Object dialog logic (PageObjectDialog.optionsChanged).
import { describe, expect, it } from 'vitest'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { PageObjectLanguage } from '../../src/core/pageobject/pageObject'
import { generatePageObject, identifier, languageOf, optionsOf, PageObjectSource, runAudit, styleOf } from '../../src/extension/locatorsModel'
import { fixture } from '../helpers/fixtures'

const ios = WdaSourceParser.parse(fixture('ios_login.xml'))
const android = UiAutomatorParser.parse(fixture('android_login.xml'))

describe('Locators tab host model', () => {
  it('the audit rows point at elements by depth first index', () => {
    const result = runAudit(android, 440, undefined, undefined, true)
    const all = [...android.walk()]
    expect(result.statusLine).toContain('Density 440 dpi')
    expect(result.statusLine).toContain('no frame')
    for (const issue of result.issues) {
      expect(all[issue.index]).toBeDefined()
      expect(all[issue.index].displayLabel()).toBe(issue.elementLabel)
    }
  })

  it('identifier keeps letters, digits and underscores', () => {
    expect(identifier('Login Page 2!', 'X')).toBe('LoginPage2')
    expect(identifier('  ', 'ScreenPage')).toBe('ScreenPage')
  })

  it('unknown language and style names fall back to the defaults', () => {
    expect(languageOf('nope')).toBe(PageObjectLanguage.MOBILEWRIGHT_TS)
    expect(styleOf('nope').name).toBe('BASE_CLASS_FIELDS')
    expect(optionsOf({ className: '', language: 'APPIUM_JAVA', style: 'GETTERS', baseClass: 'My Base', sortByName: true })).toMatchObject({ className: 'ScreenPage', baseClass: 'MyBase', sortByName: true })
  })

  it('rows, generation, the base class and the status line', () => {
    const source = new PageObjectSource(ios)
    const rows = source.rows(false)
    expect(rows.length).toBeGreaterThan(2)
    const email = rows.find((r) => r.locator?.includes('email-input'))!
    expect(email.selectedByDefault).toBe(true)
    const request = {
      appium: false,
      rows: rows.map((r) => ({ index: r.index, name: r.name, selected: r.selectedByDefault })),
      className: 'Login Page',
      language: 'MOBILEWRIGHT_TS',
      style: 'BASE_CLASS_FIELDS',
      baseClass: 'BasePage',
      generateBase: true,
      sortByName: false,
    }
    const out = generatePageObject(source, request)
    expect(out.page).toContain('class LoginPage extends BasePage')
    expect(out.page).toContain('email-input')
    expect(out.base).toContain('abstract class BasePage')
    expect(out.pageFileName).toBe('LoginPage.ts')
    expect(out.status.startsWith(`${out.count} elements`)).toBe(true)
    expect(generatePageObject(source, { ...request, generateBase: false }).base).toBeUndefined()
    expect(generatePageObject(source, { ...request, style: 'CONSTRUCTOR_FIELDS' }).base).toBeUndefined()
    expect(generatePageObject(source, { ...request, rows: [] }).page).toBe('// Tick the elements to include.')
  })

  it('Appium rows use the strategy text and a row without a unique locator is never generated', () => {
    const source = new PageObjectSource(android)
    const rows = source.rows(true)
    expect(rows.some((r) => r.locator?.startsWith('id:') || r.locator?.startsWith('accessibility id:'))).toBe(true)
    const request = {
      appium: true,
      rows: rows.map((r) => ({ index: r.index, name: r.name, selected: true })),
      className: 'Screen',
      language: 'APPIUM_PYTHON',
      style: 'BASE_CLASS_FIELDS',
      baseClass: 'BasePage',
      generateBase: true,
      sortByName: true,
    }
    const out = generatePageObject(source, request)
    expect(out.count).toBe(rows.filter((r) => r.locator !== undefined).length)
    expect(out.pageFileName).toBe('screen.py')
  })
})
