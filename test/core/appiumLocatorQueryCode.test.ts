// ported-from: test:core/AppiumLocatorQueryTest.kt
// The code-form half of `every appium locator the generator shows finds exactly its own element` (it needs PageObjectGenerator).
// The bare form half lives under the same name in appiumLocatorQuery.test.ts.
import { describe, expect, it } from 'vitest'
import { AppiumBy } from '../../src/core/inspector/appiumLocatorQuery'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import { LocatorQuery } from '../../src/core/inspector/locatorQuery'
import { LocatorGenerator } from '../../src/core/inspector/locators'
import type { UiNode } from '../../src/core/inspector/uiNode'
import { AppiumStrategy, PageLocator, PageObjectGenerator, PageObjectLanguage } from '../../src/core/pageobject/pageObject'
import { fixture } from '../helpers/fixtures'

const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))
const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))

const sameNodes = (a: UiNode[], b: UiNode[], message: string) => {
  expect(b.length, message).toBe(a.length)
  a.forEach((node, i) => expect(b[i], message).toBe(node))
}

describe('AppiumLocatorQueryTest code forms', () => {
  it('every appium locator the generator shows finds exactly its own element', () => {
    const languages = [PageObjectLanguage.APPIUM_JAVA, PageObjectLanguage.APPIUM_KOTLIN, PageObjectLanguage.APPIUM_PYTHON, PageObjectLanguage.APPIUM_CSHARP]
    let checked = 0
    for (const root of [android, ios]) {
      for (const node of [...root.walk()].filter((it) => !it.isRoot && Object.keys(it.attributes).length > 0)) {
        const suggestions = LocatorGenerator.suggest(node, root).filter((it) => it.framework === 'Appium')
        for (const s of suggestions) {
          // The bare form, as shown in the table.
          const strategy = AppiumStrategy.fromLocatorName(s.strategy)
          const bare = `${AppiumBy.entries.find((it) => it.name === strategy)!.label}=${s.expression}`
          const found = LocatorQuery.find(bare, root)
          expect(found.length, `${bare} matchCount`).toBe(s.matchCount)
          if (s.isUnique) expect(found[0], bare).toBe(node)
          // The code forms the Copy as combo writes.
          for (const language of languages) {
            const code = PageObjectGenerator.appiumCode(language, new PageLocator.Appium(strategy, s.expression))
            if (code === undefined) continue
            sameNodes(found, LocatorQuery.find(`driver.findElement(${code})`, root), `${code} matchCount`)
            sameNodes(found, LocatorQuery.find(code, root), code)
          }
          checked++
        }
      }
    }
    expect(checked, `checked ${checked}`).toBeGreaterThan(30)
  })
})
