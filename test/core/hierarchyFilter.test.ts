// ported-from: test:core/HierarchyFilterTest.kt
import { describe, expect, it } from 'vitest'
import { AttributeTerm, FilterQuery } from '../../src/core/inspector/filterQuery'
import { FilterCriteria, HierarchyFilter } from '../../src/core/inspector/hierarchyFilter'
import { UiAutomatorParser, WdaSourceParser } from '../../src/core/inspector/hierarchyParsers'
import type { UiNode } from '../../src/core/inspector/uiNode'
import { fixture } from '../helpers/fixtures'

const ios: UiNode = WdaSourceParser.parse(fixture('ios_login.xml'))
const android: UiNode = UiAutomatorParser.parse(fixture('android_login.xml'))

const shownIos = (text: string) => HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text }))!
const shownAndroid = (text: string) => HierarchyFilter.visibleNodes(android, new FilterCriteria({ text }))!
const any = (s: Set<UiNode>, p: (n: UiNode) => boolean) => [...s].some(p)
const none = (s: Set<UiNode>, p: (n: UiNode) => boolean) => ![...s].some(p)
const walk = (root: UiNode) => [...root.walk()]

describe('HierarchyFilterTest', () => {
  it('empty criteria show everything', () => {
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria())).toBeUndefined()
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: '  ' }))).toBeUndefined()
  })

  it('text matches id label and type, case insensitive, and keeps the ancestors', () => {
    const shown = HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'EMAIL' }))!
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    expect(shown.has(email)).toBe(true)
    expect(shown.has(ios)).toBe(true)
    expect(walk(ios).filter((it) => it.type === 'Button').every((it) => !shown.has(it))).toBe(true)
    expect(any(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'button' }))!, (it) => it.type === 'Button')).toBe(true)
  })

  it('visible only drops hidden elements', () => {
    const hidden = walk(ios).find((it) => it.attr('name') === 'Hidden')!
    const shown = HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'hidden' }))!
    expect(shown.has(hidden)).toBe(true)
    expect(none(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'hidden', visibleOnly: true }))!, (it) => it === hidden)).toBe(true)
  })

  it('interactive only keeps controls', () => {
    const shown = HierarchyFilter.visibleNodes(ios, new FilterCriteria({ interactiveOnly: true }))!
    const leaves = [...shown].filter((it) => it.children.every((c) => !shown.has(c)))
    expect(leaves.length).toBeGreaterThan(0)
    expect(new Set(leaves.map((it) => it.type))).toEqual(new Set(['Button', 'TextField']))
  })

  it('no match gives an empty set', () => {
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'zzz-nothing' }))!.size).toBe(0)
  })

  it('a quoted OR stays free text and an empty negated quote is ignored', () => {
    expect(FilterQuery.parse('"OR"').freeText).toBe('OR')
    const q = FilterQuery.parse('-""')
    expect(q.groups.length).toBe(0)
  })

  it('parse splits free text, terms and invalid terms', () => {
    const q = FilterQuery.parse('log in clickable=true class~Button =x')
    expect(q.freeText).toBe('log in')
    expect(q.terms.map((it) => it.toString())).toEqual(['clickable=true', 'class~Button'])
    expect(q.invalid.map((it) => it.text)).toEqual(['=x'])
  })

  it('parse handles quotes, not-equals and odd keys', () => {
    const q = FilterQuery.parse('text="Log in" id!=a "two words" http://x.y?a=b')
    expect(q.terms[0].value).toBe('Log in')
    expect(q.terms[1].operator).toBe(AttributeTerm.Operator.NOT_EQUALS)
    expect(q.freeText).toBe('two words http://x.y?a=b')
    expect(FilterQuery.parse('text="abc').invalid[0].reason).toBe('unterminated quote')
    expect(FilterQuery.parse('text="abc').invalid.length).toBe(1)
    expect(FilterQuery.parse('enabled=maybe').invalid.length).toBeGreaterThan(0)
    expect(FilterQuery.parse('enabled~tr').invalid.length).toBeGreaterThan(0)
    expect(FilterQuery.parse('   ').isEmpty).toBe(true)
  })

  it('invalid terms do not filter', () => {
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: '=x enabled=maybe' }))).toBeUndefined()
    expect(new FilterCriteria({ text: '=x enabled=maybe' }).invalidTerms.length).toBe(2)
  })

  it('type and class aliases work on iOS and Android', () => {
    expect(any(shownIos('type=Button'), (it) => it.type === 'Button')).toBe(true)
    expect(any(shownIos('class=XCUIElementTypeButton'), (it) => it.type === 'Button')).toBe(true)
    expect(any(shownIos('class~textfield'), (it) => it.type === 'TextField')).toBe(true)
    expect(any(shownAndroid('type=Button'), (it) => it.type === 'Button')).toBe(true)
    expect(any(shownAndroid('class=android.widget.Button'), (it) => it.type === 'Button')).toBe(true)
    const noButtons = shownIos('type!=Button type!=Application type!=Window')
    expect(noButtons.size).toBeGreaterThan(0)
    expect(none(noButtons, (it) => it.type === 'Button')).toBe(true)
    expect(any(noButtons, (it) => it.type === 'TextField')).toBe(true)
  })

  it('extra boolean keys and aliases are validated and applied', () => {
    expect(FilterQuery.parse('interactive=true focusable=maybe').invalid.length).toBeGreaterThan(0)
    expect(shownAndroid('interactive=true').size).toBeGreaterThan(0)
    expect(shownAndroid('id=nothing-here')).toEqual(shownAndroid('resourceid=nothing-here'))
    expect(shownAndroid('text~a')).toEqual(shownAndroid('desc~a'))
    expect(shownAndroid('text~a')).toEqual(shownAndroid('contentdesc~a'))
  })

  it('boolean aliases combine and missing counts as false', () => {
    const clickable = [...shownAndroid('clickable=true')].filter((it) => it.attr('clickable') === 'true')
    expect(clickable.length).toBeGreaterThan(0)
    expect(none(shownAndroid('clickable=true'), (it) => !it.isRoot && it.attr('clickable') === 'false' && it.children.length === 0)).toBe(true)
    expect(shownIos('enabled=true visible=true').size).toBeGreaterThan(0)
    const hidden = walk(ios).find((it) => it.attr('name') === 'Hidden')!
    expect(shownIos('visible=false').has(hidden)).toBe(true)
    expect(shownIos('visible=true').has(hidden)).toBe(false)
    expect(any(shownIos('clickable=true'), (it) => it.type === 'Button')).toBe(true)
    expect(shownAndroid('focused=true').size).toBe(0)
  })

  it('id and text aliases resolve through the accessors', () => {
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    expect(shownIos('id=EMAIL-input').has(email)).toBe(true)
    expect(shownIos('identifier~mail').has(email)).toBe(true)
    expect(shownIos('id!=email-input').has(email)).toBe(false)
    const welcome = walk(ios).find((it) => it.attr('value') === 'Welcome')!
    expect(shownIos('text=welcome').has(welcome)).toBe(true)
    expect(shownIos('label~elco value=Welcome').has(welcome)).toBe(true)
    expect(shownIos('text=welcome id=email-input').has(welcome)).toBe(false)
    const androidWithId = walk(android).find((it) => (it.resourceId?.length ?? 0) > 0)!
    const rid = androidWithId.resourceId!
    const short = rid.includes(':id/') ? rid.slice(rid.indexOf(':id/') + 4) : rid
    expect(shownAndroid(`resource-id=${short}`).has(androidWithId)).toBe(true)
    expect(shownAndroid(`id=${rid}`).has(androidWithId)).toBe(true)
  })

  it('unknown keys use the raw attribute map and free text still combines', () => {
    expect(shownAndroid('package=com.example.app').size).toBeGreaterThan(0)
    expect(shownAndroid('package=other').size).toBe(0)
    expect(shownAndroid('PACKAGE~example').size).toBeGreaterThan(0)
    expect(shownAndroid('nosuchkey=x').size).toBe(0)
    expect(shownAndroid('nosuchkey!=x').size).toBeGreaterThan(0)
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    expect(shownIos('email type=TextField').has(email)).toBe(true)
    expect(shownIos('email type=Button').has(email)).toBe(false)
  })

  it('existing queries parse into one group', () => {
    const q = FilterQuery.parse('log in clickable=true class~Button')
    expect(q.groups.length).toBe(1)
    expect(q.groups[0].freeText).toBe('log in')
    expect(q.groups[0].notTerms.length === 0 && q.groups[0].notFree.length === 0 && q.groups[0].regexes.length === 0).toBe(true)
    // lone dashes, bang-equals and words that merely contain OR or | stay as before
    expect(FilterQuery.parse('a - b ORA x|y').freeText).toBe('a - b ORA x|y')
    expect(FilterQuery.parse('or').freeText).toBe('or')
    expect(FilterQuery.parse('!=x').invalid.map((it) => it.text)).toEqual(['!=x'])
    expect(FilterQuery.parse('resource-id=a').terms[0].toString()).toBe('resource-id=a')
  })

  it('OR shows elements of either group', () => {
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    const welcome = walk(ios).find((it) => it.attr('value') === 'Welcome')!
    const either = shownIos('email-input OR welcome')
    expect(either.has(email) && either.has(welcome)).toBe(true)
    expect(shownIos('welcome').has(email)).toBe(false)
    expect(shownIos('email-input | welcome')).toEqual(either)
    const s = shownIos('type=Button OR type=TextField')
    expect(any(s, (it) => it.type === 'Button') && any(s, (it) => it.type === 'TextField')).toBe(true)
    expect(shownIos('welcome OR')).toEqual(shownIos('welcome'))
    expect(FilterQuery.parse('a b OR c=d').groups.length).toBe(2)
    expect(FilterQuery.parse('OR | OR').isEmpty).toBe(true)
  })

  it('leading dash or bang negates one word', () => {
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    expect(shownIos('-email').has(email)).toBe(false)
    expect(shownIos('!email').has(email)).toBe(false)
    expect(shownIos('type=TextField -button').has(email)).toBe(true)
    expect(shownIos('type=TextField -email').has(email)).toBe(false)
    expect(none(shownIos('type=Button -type=Button'), (it) => it.type === 'Button')).toBe(true)
    expect(any(shownIos('-type=Button'), (it) => it.type === 'TextField')).toBe(true)
    expect(none(shownIos('-type=Button'), (it) => it.type === 'Button')).toBe(true)
    expect(shownIos('-"email input" -email-input').has(email)).toBe(false)
    expect(FilterQuery.parse('-"two words"').groups[0].notFree).toEqual(['two words'])
    expect(FilterQuery.parse('-"two words"').groups.length).toBe(1)
    expect(shownIos('-welcome type=TextField OR -type=TextField').has(email)).toBe(true)
  })

  it('regular expressions between slashes', () => {
    const email = walk(ios).find((it) => it.identifier === 'email-input')!
    expect(shownIos('/^email-.*put$/').has(email)).toBe(true)
    expect(shownIos('/EMAIL/').has(email)).toBe(true)
    expect(shownIos('/^mail/').has(email)).toBe(false)
    expect(shownIos('-/email/').has(email)).toBe(false)
    expect(shownIos('/email/ /input/').has(email)).toBe(true)
    expect(shownIos('"/email|welcome/"').has(email)).toBe(true)
    expect(shownIos('/zzz/ OR /e.ail/').has(email)).toBe(true)
    expect(FilterQuery.parse('/(/').invalid[0].reason).toContain('regular expression')
    expect(FilterQuery.parse('/(/').invalid.length).toBe(1)
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: '/(/' }))).toBeUndefined()
    // too short to be a regex, so still free text
    expect(FilterQuery.parse('//').freeText).toBe('//')
    expect(FilterQuery.parse('/').freeText).toBe('/')
  })

  it('checkboxes keep working next to terms', () => {
    const hidden = walk(ios).find((it) => it.attr('name') === 'Hidden')!
    expect(HierarchyFilter.visibleNodes(ios, new FilterCriteria({ text: 'name~hidden', visibleOnly: true }))!.has(hidden)).toBe(false)
    expect(new FilterCriteria({ text: 'a=b' }).isEmpty).toBe(false)
    expect(new FilterCriteria({ text: '=x' }).isEmpty).toBe(true)
  })
})
