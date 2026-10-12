// ported-from: core/pageobject/PageObject.kt
import { AccessibilityAudit } from '../inspector/accessibilityAudit'
import { LocatorGenerator, type LocatorSuggestion } from '../inspector/locators'
import type { UiNode } from '../inspector/uiNode'

/** What the page object is written for: a framework and a language. Mobilewright is JavaScript only. */
export interface PageObjectLanguage {
  readonly name: string
  readonly label: string
  readonly appium: boolean
  readonly extension: string
  toString(): string
}

const pageObjectLanguage = (name: string, label: string, appium: boolean, extension: string): PageObjectLanguage => ({ name, label, appium, extension, toString: () => label })

const MOBILEWRIGHT_TS = pageObjectLanguage('MOBILEWRIGHT_TS', 'Mobilewright - TypeScript', false, 'ts')
const MOBILEWRIGHT_JS = pageObjectLanguage('MOBILEWRIGHT_JS', 'Mobilewright - JavaScript', false, 'js')
const PO_APPIUM_JAVA = pageObjectLanguage('APPIUM_JAVA', 'Appium - Java', true, 'java')
const PO_APPIUM_KOTLIN = pageObjectLanguage('APPIUM_KOTLIN', 'Appium - Kotlin', true, 'kt')
const PO_APPIUM_PYTHON = pageObjectLanguage('APPIUM_PYTHON', 'Appium - Python', true, 'py')
const PO_APPIUM_CSHARP = pageObjectLanguage('APPIUM_CSHARP', 'Appium - C#', true, 'cs')

export const PageObjectLanguage = {
  MOBILEWRIGHT_TS,
  MOBILEWRIGHT_JS,
  APPIUM_JAVA: PO_APPIUM_JAVA,
  APPIUM_KOTLIN: PO_APPIUM_KOTLIN,
  APPIUM_PYTHON: PO_APPIUM_PYTHON,
  APPIUM_CSHARP: PO_APPIUM_CSHARP,
  /** Kotlin `entries`. */
  entries: [MOBILEWRIGHT_TS, MOBILEWRIGHT_JS, PO_APPIUM_JAVA, PO_APPIUM_KOTLIN, PO_APPIUM_PYTHON, PO_APPIUM_CSHARP] as readonly PageObjectLanguage[],
}

export type AppiumStrategy = 'ID' | 'ACCESSIBILITY_ID' | 'ANDROID_UIAUTOMATOR' | 'IOS_PREDICATE' | 'IOS_CLASS_CHAIN' | 'XPATH'

export const AppiumStrategy = {
  ID: 'ID',
  ACCESSIBILITY_ID: 'ACCESSIBILITY_ID',
  ANDROID_UIAUTOMATOR: 'ANDROID_UIAUTOMATOR',
  IOS_PREDICATE: 'IOS_PREDICATE',
  IOS_CLASS_CHAIN: 'IOS_CLASS_CHAIN',
  XPATH: 'XPATH',

  /** Maps the strategy name of a Locators-tab row (`id`, `accessibility id`, `xpath (in parent)`, ...) to the strategy. */
  fromLocatorName(strategy: string): AppiumStrategy {
    switch (strategy) {
      case 'id':
        return 'ID'
      case 'accessibility id':
        return 'ACCESSIBILITY_ID'
      case '-android uiautomator':
        return 'ANDROID_UIAUTOMATOR'
      case '-ios predicate string':
        return 'IOS_PREDICATE'
      case '-ios class chain':
        return 'IOS_CLASS_CHAIN'
      default:
        return 'XPATH'
    }
  },
} as const

/** How an element is found: Mobilewright code starting with `screen.`, or an Appium strategy and its value. */
export type PageLocator = PageLocator.Mobilewright | PageLocator.Appium
export namespace PageLocator {
  export class Mobilewright {
    constructor(readonly expression: string) {}
  }
  export class Appium {
    constructor(
      readonly strategy: AppiumStrategy,
      readonly value: string,
    ) {}
  }
}

export type PageAction = 'TAP' | 'FILL' | 'READ'
export const PageAction = { TAP: 'TAP', FILL: 'FILL', READ: 'READ' } as const

/** Where the locators of a page object live. */
export interface LocatorStyle {
  readonly name: string
  readonly label: string
  readonly usesBaseClass: boolean
  toString(): string
}

const locatorStyle = (name: string, label: string, usesBaseClass: boolean): LocatorStyle => ({ name, label, usesBaseClass, toString: () => label })

const BASE_CLASS_FIELDS = locatorStyle('BASE_CLASS_FIELDS', 'Fields, screen/driver from the base class', true)
const GETTERS = locatorStyle('GETTERS', 'Getters, screen/driver from the base class', true)
const CONSTRUCTOR_FIELDS = locatorStyle('CONSTRUCTOR_FIELDS', 'Fields, set in the constructor (no base class)', false)

export const LocatorStyle = {
  /** Private fields, the screen or driver comes from the base class: no constructor of its own (a one-liner in Java, Kotlin and C#). */
  BASE_CLASS_FIELDS,
  /** Private getters (properties), the screen or driver comes from the base class. */
  GETTERS,
  /** Private fields filled in the constructor; the class stands alone, without a base class. */
  CONSTRUCTOR_FIELDS,
  entries: [BASE_CLASS_FIELDS, GETTERS, CONSTRUCTOR_FIELDS] as readonly LocatorStyle[],
}

export interface PageObjectOptions {
  readonly className: string
  readonly language: PageObjectLanguage
  readonly style?: LocatorStyle
  /** The class the page object extends (for the base-class styles). */
  readonly baseClass?: string
  readonly sortByName?: boolean
}

/** One element of a page object: a name, the locator and the methods to generate for it. */
export class PageElement {
  constructor(
    readonly name: string,
    readonly actions: ReadonlySet<PageAction>,
    readonly locator: PageLocator,
  ) {}
}

/** An element of the current screen that could go into a page object. [locator] is undefined when no unique one exists. */
export class PageCandidate {
  constructor(
    readonly node: UiNode,
    readonly suggestedName: string,
    readonly actions: ReadonlySet<PageAction>,
    readonly locator: PageLocator | undefined,
    /** Controls (buttons, fields, switches) are ticked at first; plain texts are offered but not ticked. */
    readonly selectedByDefault: boolean,
  ) {}

  get typeName(): string {
    return this.node.type
  }
}

const inputTypes = new Set(['textfield', 'securetextfield', 'searchfield', 'edittext', 'reactedittext'])

/** Appium strategies in order of preference, as named in the Locators tab. */
const appiumOrder = ['id', 'accessibility id', '-android uiautomator', '-ios predicate string', '-ios class chain', 'xpath (in parent)', 'xpath']

/** Hands out names that are unique within one page object. */
class NameBook {
  private readonly used = new Map<string, number>()
  unique(name: string): string {
    const key = name.toLowerCase()
    const count = (this.used.get(key) ?? 0) + 1
    this.used.set(key, count)
    return count === 1 ? name : `${name} ${count}`
  }
}

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim() === ''

export const PageObjectCandidates = {
  /** Visible elements with a locator of the chosen framework, in tree order. */
  find(root: UiNode, appium: boolean): PageCandidate[] {
    const names = new NameBook()
    const result: PageCandidate[] = []
    for (const node of root.walk()) {
      if (node.isRoot || !node.isVisible) continue
      const actions = actionsFor(node)
      if (actions === undefined) continue
      const suggestions = LocatorGenerator.suggest(node, root)
      const locator = appium ? appiumLocator(suggestions) : mobilewrightLocator(suggestions)
      const base = baseName(node)
      if (base === undefined) continue
      result.push(new PageCandidate(node, names.unique(base), actions, locator, [...actions].some((it) => it !== 'READ')))
    }
    return result
  },

  /** The best unique Appium locator of [node] in [root], or undefined when it has none. */
  appiumLocatorFor(node: UiNode, root: UiNode): PageLocator.Appium | undefined {
    return appiumLocator(LocatorGenerator.suggest(node, root))
  },
}

function actionsFor(node: UiNode): Set<PageAction> | undefined {
  const type = node.type.toLowerCase()
  if (inputTypes.has(type)) return new Set<PageAction>(['FILL', 'READ'])
  if (AccessibilityAudit.isInteractive(node)) return new Set<PageAction>(['TAP'])
  if (!isBlank(node.text ?? node.label ?? node.value)) return new Set<PageAction>(['READ'])
  return undefined
}

function mobilewrightLocator(suggestions: readonly LocatorSuggestion[]): PageLocator.Mobilewright | undefined {
  const s = suggestions.find((it) => it.framework === 'Mobilewright' && it.isUnique)
  return s === undefined ? undefined : new PageLocator.Mobilewright(s.expression)
}

function appiumLocator(suggestions: readonly LocatorSuggestion[]): PageLocator.Appium | undefined {
  for (const strategy of appiumOrder) {
    const suggestion = suggestions.find((it) => it.framework === 'Appium' && it.strategy === strategy && it.isUnique)
    if (suggestion === undefined) continue
    return new PageLocator.Appium(AppiumStrategy.fromLocatorName(strategy), suggestion.expression)
  }
  return undefined
}

/** Kotlin `substringAfter(delimiter)`: the whole string when the delimiter is missing. */
const substringAfter = (s: string, delimiter: string): string => {
  const i = s.indexOf(delimiter)
  return i < 0 ? s : s.slice(i + delimiter.length)
}

/** Words for the name, from the test id (without the package prefix), else the label or text; plus what kind of element it is. */
function baseName(node: UiNode): string | undefined {
  const raw = node.identifier ?? (node.resourceId !== undefined ? substringAfter(node.resourceId, ':id/') : undefined) ?? node.label ?? node.text ?? node.value
  if (raw === undefined || isBlank(raw)) return undefined
  const words = raw.split(/[^A-Za-z0-9]+/).filter((it) => it.length > 0).slice(0, 5)
  if (words.length === 0) return undefined
  const suffix = kindWord(node)
  const joined = words.join(' ')
  return joined.toLowerCase().endsWith(suffix.toLowerCase()) ? joined : `${joined} ${suffix}`
}

function kindWord(node: UiNode): string {
  const type = node.type.toLowerCase()
  if (inputTypes.has(type)) return 'field'
  if (type.includes('switch') || type.includes('toggle')) return 'switch'
  if (type.includes('checkbox')) return 'checkbox'
  if (type.includes('button')) return 'button'
  if (type.includes('image')) return 'image'
  if (type === 'cell' || type.includes('tab')) return 'item'
  if (AccessibilityAudit.isInteractive(node)) return 'button'
  return 'text'
}

const COMMENT = 'Locators are private. Make one public only when a test needs it, for example in an expect or assertion.'

/** Kotlin `String.replaceFirstChar { it.lowercase() }`. */
const lowerFirst = (w: string): string => (w.length === 0 ? w : w[0].toLowerCase() + w.slice(1))
const upperFirst = (w: string): string => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1))

// ---- naming

/** The words of a name: split at anything that is not a letter or digit, and where a lower case letter meets an upper case one. */
const words = (name: string): string[] =>
  name
    .split(/[^A-Za-z0-9]+/)
    .flatMap((it) => it.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter((it) => it.length > 0)

const camel = (name: string): string => words(name).map((w, i) => (i === 0 ? lowerFirst(w) : upperFirst(w))).join('')
const pascal = (name: string): string => words(name).map(upperFirst).join('')
const snake = (name: string): string => words(name).map((w) => w.toLowerCase()).join('_')

/** Keeps an identifier valid when a name starts with a digit. */
const safe = (identifier: string): string => (identifier.length > 0 && /^\p{Nd}/u.test(identifier) ? `_${identifier}` : identifier)

const readsValue = (e: PageElement): boolean => e.actions.has('FILL')

/** The words of the reading method's name: "welcome text" is read by `getWelcomeText`, not `getWelcomeTextText`. */
function readWords(e: PageElement): string {
  const suffix = readsValue(e) ? 'value' : 'text'
  const last = words(e.name).at(-1)
  return last !== undefined && last.toLowerCase() === suffix ? e.name : `${e.name} ${suffix}`
}

/** Kotlin `buildString` with `appendLine`. */
class Lines {
  private text = ''
  appendLine(line = ''): void {
    this.text += line + '\n'
  }
  toString(): string {
    return this.text
  }
}

const styleOf = (o: PageObjectOptions): LocatorStyle => o.style ?? LocatorStyle.BASE_CLASS_FIELDS
const baseOf = (o: PageObjectOptions): string => o.baseClass ?? 'BasePage'

function quote(text: string, kotlin = false): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
  return '"' + (kotlin ? escaped.replaceAll('$', '\\$') : escaped) + '"'
}

function javaLocator(l: PageLocator.Appium, kotlin: boolean): string {
  const v = quote(l.value, kotlin)
  switch (l.strategy) {
    case 'ID':
      return `By.id(${v})`
    case 'ACCESSIBILITY_ID':
      return `AppiumBy.accessibilityId(${v})`
    case 'ANDROID_UIAUTOMATOR':
      return `AppiumBy.androidUIAutomator(${v})`
    case 'IOS_PREDICATE':
      return `AppiumBy.iOSNsPredicateString(${v})`
    case 'IOS_CLASS_CHAIN':
      return `AppiumBy.iOSClassChain(${v})`
    case 'XPATH':
      return `By.xpath(${v})`
  }
}

// The .NET client (Appium.WebDriver) has no AppiumBy class: the Appium strategies live in MobileBy (checked against its source on GitHub, not against the NuGet package).
function csharpLocator(l: PageLocator.Appium): string {
  const v = quote(l.value)
  switch (l.strategy) {
    case 'ID':
      return `By.Id(${v})`
    case 'ACCESSIBILITY_ID':
      return `MobileBy.AccessibilityId(${v})`
    case 'ANDROID_UIAUTOMATOR':
      return `MobileBy.AndroidUIAutomator(${v})`
    case 'IOS_PREDICATE':
      return `MobileBy.IosNSPredicate(${v})`
    case 'IOS_CLASS_CHAIN':
      return `MobileBy.IosClassChain(${v})`
    case 'XPATH':
      return `By.XPath(${v})`
  }
}

function pythonLocator(l: PageLocator.Appium): string {
  // The strategy names are the Python AppiumBy constants.
  return `(AppiumBy.${l.strategy}, ${quote(l.value)})`
}

const appium = (e: PageElement): PageLocator.Appium => e.locator as PageLocator.Appium

export const PageObjectGenerator = {
  /** The page object class. */
  generate(elements: readonly PageElement[], o: PageObjectOptions): string {
    const ordered = o.sortByName ? [...elements].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase())) : elements
    switch (o.language) {
      case PageObjectLanguage.MOBILEWRIGHT_TS:
        return mobilewright(o, ordered, true)
      case PageObjectLanguage.MOBILEWRIGHT_JS:
        return mobilewright(o, ordered, false)
      case PageObjectLanguage.APPIUM_JAVA:
        return java(o, ordered)
      case PageObjectLanguage.APPIUM_KOTLIN:
        return kotlin(o, ordered)
      case PageObjectLanguage.APPIUM_PYTHON:
        return python(o, ordered)
      case PageObjectLanguage.APPIUM_CSHARP:
        return csharp(o, ordered)
      default:
        throw new Error(`Unknown page object language ${o.language.name}`)
    }
  },

  /** The file name for a class: Python files are snake_case modules, the others are named after the class. */
  fileName(language: PageObjectLanguage, className: string): string {
    return (language === PageObjectLanguage.APPIUM_PYTHON ? snake(className) : className) + '.' + language.extension
  },

  /** The base class that holds the screen or driver, named [PageObjectOptions.baseClass]. */
  generateBaseClass(o: PageObjectOptions): string {
    const b = baseOf(o)
    switch (o.language) {
      case PageObjectLanguage.MOBILEWRIGHT_TS:
        return [`import type { Screen } from 'mobilewright';`, '', `export abstract class ${b} {`, '  constructor(protected readonly screen: Screen) {}', '}', ''].join('\n')
      case PageObjectLanguage.MOBILEWRIGHT_JS:
        return [`export class ${b} {`, '  constructor(screen) {', '    this.screen = screen;', '  }', '}', ''].join('\n')
      case PageObjectLanguage.APPIUM_JAVA:
        return [
          'import io.appium.java_client.AppiumDriver;',
          '',
          `public abstract class ${b} {`,
          '    protected final AppiumDriver driver;',
          '',
          `    protected ${b}(AppiumDriver driver) {`,
          '        this.driver = driver;',
          '    }',
          '}',
          '',
        ].join('\n')
      case PageObjectLanguage.APPIUM_KOTLIN:
        return ['import io.appium.java_client.AppiumDriver', '', `abstract class ${b}(protected val driver: AppiumDriver)`, ''].join('\n')
      case PageObjectLanguage.APPIUM_PYTHON:
        return [`class ${b}:`, '    def __init__(self, driver):', '        self.driver = driver', ''].join('\n')
      case PageObjectLanguage.APPIUM_CSHARP:
        return [
          'using OpenQA.Selenium.Appium;',
          '',
          `public abstract class ${b}`,
          '{',
          '    protected readonly AppiumDriver Driver;',
          '',
          `    protected ${b}(AppiumDriver driver)`,
          '    {',
          '        Driver = driver;',
          '    }',
          '}',
          '',
        ].join('\n')
      default:
        throw new Error(`Unknown page object language ${o.language.name}`)
    }
  },

  quote,

  /**
   * One Appium locator as code in [language] (an Appium language; other languages give undefined).
   * Java and Kotlin: `By.id("x")`; Python: `(AppiumBy.ID, "x")`; C#: `By.Id("x")`.
   */
  appiumCode(language: PageObjectLanguage, l: PageLocator.Appium): string | undefined {
    switch (language) {
      case PageObjectLanguage.APPIUM_JAVA:
        return javaLocator(l, false)
      case PageObjectLanguage.APPIUM_KOTLIN:
        return javaLocator(l, true)
      case PageObjectLanguage.APPIUM_PYTHON:
        return pythonLocator(l)
      case PageObjectLanguage.APPIUM_CSHARP:
        return csharpLocator(l)
      default:
        return undefined
    }
  },
}

/** String comparison by UTF-16 code units, like Kotlin's String.compareTo. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ---- Mobilewright (TypeScript, JavaScript)

function mobilewright(o: PageObjectOptions, elements: readonly PageElement[], typescript: boolean): string {
  const out = new Lines()
  const style = styleOf(o)
  const standalone = style === LocatorStyle.CONSTRUCTOR_FIELDS
  const expression = (e: PageElement): string => (e.locator as PageLocator.Mobilewright).expression
  // How the page's own methods refer to a locator.
  const ref = (e: PageElement): string => (typescript ? `this.${safe(camel(e.name))}` : `this.#${safe(camel(e.name))}`)
  if (standalone) {
    if (typescript) {
      out.appendLine("import type { Screen } from 'mobilewright';")
      out.appendLine()
    }
    out.appendLine(`export class ${o.className} {`)
  } else {
    out.appendLine(`import { ${baseOf(o)} } from './${baseOf(o)}';`)
    out.appendLine()
    out.appendLine(`export class ${o.className} extends ${baseOf(o)} {`)
  }
  out.appendLine(`  // ${COMMENT}`)
  for (const e of elements) {
    const f = safe(camel(e.name))
    const name = typescript ? f : `#${f}`
    switch (style) {
      case LocatorStyle.BASE_CLASS_FIELDS:
        out.appendLine(typescript ? `  private readonly ${f} = this.${expression(e)};` : `  #${f} = this.${expression(e)};`)
        break
      case LocatorStyle.GETTERS:
        out.appendLine(`  ${typescript ? 'private ' : ''}get ${name}() {`)
        out.appendLine(`    return this.${expression(e)};`)
        out.appendLine('  }')
        break
      case LocatorStyle.CONSTRUCTOR_FIELDS:
        out.appendLine(typescript ? `  private readonly ${f}: ReturnType<Screen['getByTestId']>;` : `  #${f};`)
        break
    }
  }
  if (standalone) {
    out.appendLine()
    out.appendLine(typescript ? '  constructor(screen: Screen) {' : '  constructor(screen) {')
    for (const e of elements) out.appendLine(`    ${ref(e)} = ${expression(e)};`)
    out.appendLine('  }')
  }
  for (const e of elements) {
    const r = ref(e)
    if (e.actions.has('TAP')) {
      out.appendLine()
      out.appendLine(`  async tap${pascal(e.name)}()${typescript ? ': Promise<void>' : ''} {`)
      out.appendLine(`    await ${r}.tap();`)
      out.appendLine('  }')
    }
    if (e.actions.has('FILL')) {
      out.appendLine()
      out.appendLine(`  async fill${pascal(e.name)}(text${typescript ? ': string' : ''})${typescript ? ': Promise<void>' : ''} {`)
      out.appendLine(`    await ${r}.fill(text);`)
      out.appendLine('  }')
    }
    if (e.actions.has('READ')) {
      out.appendLine()
      out.appendLine(`  async get${pascal(readWords(e))}()${typescript ? ': Promise<string>' : ''} {`)
      out.appendLine(`    return ${r}.${readsValue(e) ? 'getValue' : 'getText'}();`)
      out.appendLine('  }')
    }
  }
  out.appendLine('}')
  return out.toString()
}

// ---- Appium (Java, Kotlin, Python, C#)

function java(o: PageObjectOptions, elements: readonly PageElement[]): string {
  const out = new Lines()
  const style = styleOf(o)
  const standalone = style === LocatorStyle.CONSTRUCTOR_FIELDS
  const field = (e: PageElement): string => safe(camel(e.name))
  const ref = (e: PageElement): string => (style === LocatorStyle.GETTERS ? `${field(e)}()` : field(e))
  out.appendLine('import io.appium.java_client.AppiumBy;')
  out.appendLine('import io.appium.java_client.AppiumDriver;')
  out.appendLine('import org.openqa.selenium.By;')
  out.appendLine()
  out.appendLine(`public class ${o.className}${standalone ? '' : ` extends ${baseOf(o)}`} {`)
  out.appendLine(`    // ${COMMENT}`)
  if (standalone) out.appendLine('    private final AppiumDriver driver;')
  for (const e of elements) {
    switch (style) {
      case LocatorStyle.BASE_CLASS_FIELDS:
        out.appendLine(`    private final By ${field(e)} = ${javaLocator(appium(e), false)};`)
        break
      case LocatorStyle.GETTERS:
        out.appendLine(`    private By ${field(e)}() {`)
        out.appendLine(`        return ${javaLocator(appium(e), false)};`)
        out.appendLine('    }')
        break
      case LocatorStyle.CONSTRUCTOR_FIELDS:
        out.appendLine(`    private final By ${field(e)};`)
        break
    }
  }
  out.appendLine()
  out.appendLine(`    public ${o.className}(AppiumDriver driver) {`)
  if (standalone) {
    out.appendLine('        this.driver = driver;')
    for (const e of elements) out.appendLine(`        this.${field(e)} = ${javaLocator(appium(e), false)};`)
  } else {
    out.appendLine('        super(driver);')
  }
  out.appendLine('    }')
  for (const e of elements) {
    const r = ref(e)
    if (e.actions.has('TAP')) {
      out.appendLine()
      out.appendLine(`    public void tap${pascal(e.name)}() {`)
      out.appendLine(`        driver.findElement(${r}).click();`)
      out.appendLine('    }')
    }
    if (e.actions.has('FILL')) {
      out.appendLine()
      out.appendLine(`    public void fill${pascal(e.name)}(String text) {`)
      out.appendLine(`        driver.findElement(${r}).sendKeys(text);`)
      out.appendLine('    }')
    }
    if (e.actions.has('READ')) {
      out.appendLine()
      out.appendLine(`    public String get${pascal(readWords(e))}() {`)
      out.appendLine(`        return driver.findElement(${r}).${readsValue(e) ? 'getAttribute("value")' : 'getText()'};`)
      out.appendLine('    }')
    }
  }
  out.appendLine('}')
  return out.toString()
}

function kotlin(o: PageObjectOptions, elements: readonly PageElement[]): string {
  const out = new Lines()
  const style = styleOf(o)
  const standalone = style === LocatorStyle.CONSTRUCTOR_FIELDS
  const field = (e: PageElement): string => safe(camel(e.name))
  out.appendLine('import io.appium.java_client.AppiumBy')
  out.appendLine('import io.appium.java_client.AppiumDriver')
  out.appendLine('import org.openqa.selenium.By')
  out.appendLine()
  out.appendLine(standalone ? `class ${o.className}(private val driver: AppiumDriver) {` : `class ${o.className}(driver: AppiumDriver) : ${baseOf(o)}(driver) {`)
  out.appendLine(`    // ${COMMENT}`)
  for (const e of elements) {
    switch (style) {
      case LocatorStyle.BASE_CLASS_FIELDS:
        out.appendLine(`    private val ${field(e)}: By = ${javaLocator(appium(e), true)}`)
        break
      case LocatorStyle.GETTERS:
        out.appendLine(`    private val ${field(e)}: By get() = ${javaLocator(appium(e), true)}`)
        break
      case LocatorStyle.CONSTRUCTOR_FIELDS:
        out.appendLine(`    private val ${field(e)}: By`)
        break
    }
  }
  if (standalone) {
    out.appendLine()
    out.appendLine('    init {')
    for (const e of elements) out.appendLine(`        ${field(e)} = ${javaLocator(appium(e), true)}`)
    out.appendLine('    }')
  }
  for (const e of elements) {
    const f = field(e)
    if (e.actions.has('TAP')) {
      out.appendLine()
      out.appendLine(`    fun tap${pascal(e.name)}() {`)
      out.appendLine(`        driver.findElement(${f}).click()`)
      out.appendLine('    }')
    }
    if (e.actions.has('FILL')) {
      out.appendLine()
      out.appendLine(`    fun fill${pascal(e.name)}(text: String) {`)
      out.appendLine(`        driver.findElement(${f}).sendKeys(text)`)
      out.appendLine('    }')
    }
    if (e.actions.has('READ')) {
      out.appendLine()
      out.appendLine(`    fun get${pascal(readWords(e))}(): String =`)
      out.appendLine(`        driver.findElement(${f}).${readsValue(e) ? 'getAttribute("value")' : 'text'}`)
    }
  }
  out.appendLine('}')
  return out.toString()
}

function python(o: PageObjectOptions, elements: readonly PageElement[]): string {
  const out = new Lines()
  const style = styleOf(o)
  const standalone = style === LocatorStyle.CONSTRUCTOR_FIELDS
  // Constants for fields, lower case attributes for the other styles.
  const field = (e: PageElement): string => {
    const it = safe(snake(e.name))
    return style === LocatorStyle.BASE_CLASS_FIELDS ? `_${it.toUpperCase()}` : `_${it}`
  }
  out.appendLine('from appium.webdriver.common.appiumby import AppiumBy')
  if (!standalone) out.appendLine(`from ${snake(baseOf(o))} import ${baseOf(o)}`)
  out.appendLine()
  out.appendLine()
  out.appendLine(standalone ? `class ${o.className}:` : `class ${o.className}(${baseOf(o)}):`)
  out.appendLine(`    # ${COMMENT}`)
  switch (style) {
    case LocatorStyle.BASE_CLASS_FIELDS:
      for (const e of elements) out.appendLine(`    ${field(e)} = ${pythonLocator(appium(e))}`)
      break
    case LocatorStyle.GETTERS:
      for (const e of elements) {
        out.appendLine('    @property')
        out.appendLine(`    def ${field(e)}(self):`)
        out.appendLine(`        return ${pythonLocator(appium(e))}`)
        out.appendLine()
      }
      break
    case LocatorStyle.CONSTRUCTOR_FIELDS:
      out.appendLine('    def __init__(self, driver):')
      out.appendLine('        self.driver = driver')
      for (const e of elements) out.appendLine(`        self.${field(e)} = ${pythonLocator(appium(e))}`)
      break
  }
  for (const e of elements) {
    const f = field(e)
    if (e.actions.has('TAP')) {
      out.appendLine()
      out.appendLine(`    def tap_${snake(e.name)}(self):`)
      out.appendLine(`        self.driver.find_element(*self.${f}).click()`)
    }
    if (e.actions.has('FILL')) {
      out.appendLine()
      out.appendLine(`    def fill_${snake(e.name)}(self, text):`)
      out.appendLine(`        self.driver.find_element(*self.${f}).send_keys(text)`)
    }
    if (e.actions.has('READ')) {
      out.appendLine()
      out.appendLine(`    def get_${snake(readWords(e))}(self):`)
      out.appendLine(`        return self.driver.find_element(*self.${f}).${readsValue(e) ? 'get_attribute("value")' : 'text'}`)
    }
  }
  return out.toString().trimEnd() + '\n'
}

function csharp(o: PageObjectOptions, elements: readonly PageElement[]): string {
  const out = new Lines()
  const style = styleOf(o)
  const standalone = style === LocatorStyle.CONSTRUCTOR_FIELDS
  const driver = standalone ? '_driver' : 'Driver'
  const field = (e: PageElement): string => (style === LocatorStyle.GETTERS ? pascal(e.name) : `_${camel(e.name)}`)
  out.appendLine('using OpenQA.Selenium;')
  out.appendLine('using OpenQA.Selenium.Appium;')
  out.appendLine()
  out.appendLine(`public class ${o.className}${standalone ? '' : ` : ${baseOf(o)}`}`)
  out.appendLine('{')
  out.appendLine(`    // ${COMMENT}`)
  if (standalone) out.appendLine('    private readonly AppiumDriver _driver;')
  for (const e of elements) {
    switch (style) {
      case LocatorStyle.BASE_CLASS_FIELDS:
        out.appendLine(`    private readonly By ${field(e)} = ${csharpLocator(appium(e))};`)
        break
      case LocatorStyle.GETTERS:
        out.appendLine(`    private By ${field(e)} => ${csharpLocator(appium(e))};`)
        break
      case LocatorStyle.CONSTRUCTOR_FIELDS:
        out.appendLine(`    private readonly By ${field(e)};`)
        break
    }
  }
  out.appendLine()
  if (standalone) {
    out.appendLine(`    public ${o.className}(AppiumDriver driver)`)
    out.appendLine('    {')
    out.appendLine('        _driver = driver;')
    for (const e of elements) out.appendLine(`        ${field(e)} = ${csharpLocator(appium(e))};`)
    out.appendLine('    }')
  } else {
    out.appendLine(`    public ${o.className}(AppiumDriver driver) : base(driver)`)
    out.appendLine('    {')
    out.appendLine('    }')
  }
  for (const e of elements) {
    const f = field(e)
    if (e.actions.has('TAP')) {
      out.appendLine()
      out.appendLine(`    public void Tap${pascal(e.name)}() => ${driver}.FindElement(${f}).Click();`)
    }
    if (e.actions.has('FILL')) {
      out.appendLine()
      out.appendLine(`    public void Fill${pascal(e.name)}(string text) => ${driver}.FindElement(${f}).SendKeys(text);`)
    }
    if (e.actions.has('READ')) {
      out.appendLine()
      out.appendLine(`    public string Get${pascal(readWords(e))}() => ${driver}.FindElement(${f}).${readsValue(e) ? 'GetAttribute("value")' : 'Text'};`)
    }
  }
  out.appendLine('}')
  return out.toString()
}
