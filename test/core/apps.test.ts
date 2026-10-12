// ported-from: test:core/AppsTest.kt
import { describe, expect, it } from 'vitest'
import { appInfo, Apps, ForegroundApp } from '../../src/core/apps/apps'
import { MobilecliJson } from '../../src/core/mobilecliJson'
import { makeDevice } from '../../src/core/model'
import { fixture as readFixture } from '../helpers/fixtures'

const android = makeDevice({ id: 'emulator-5554', name: 'Pixel', platform: 'ANDROID', kind: 'EMULATOR' })
const sim = makeDevice({ id: 'F236', name: 'iPhone', platform: 'IOS', kind: 'SIMULATOR' })
const phone = makeDevice({ id: '0000-1', name: 'iPhone', platform: 'IOS', kind: 'PHYSICAL' })

const fixture = (name: string) => MobilecliJson.data(readFixture(name))

describe('AppsTest', () => {
  it('android fixture parses and sorts by name', () => {
    const apps = Apps.parseList(fixture('mobilecli-apps-list-android.json'))
    expect(apps).toHaveLength(24)
    const names = apps.map((a) => a.name.toLowerCase())
    expect(names).toEqual([...names].sort())
    expect(apps.some((a) => a.id === 'com.android.settings' && a.name === 'Settings')).toBe(true)
  })

  it('ios fixture parses', () => {
    const apps = Apps.parseList(fixture('mobilecli-apps-list-ios.json'))
    expect(apps).toHaveLength(40)
    expect(apps.some((a) => a.id === 'com.apple.Preferences')).toBe(true)
  })

  it('list tolerates junk', () => {
    expect(Apps.parseList(undefined)).toEqual([])
    const apps = Apps.parseList(JSON.parse('[{"appName":"x"},{"packageName":"a.b"},5]'))
    expect(apps).toHaveLength(1)
    expect(apps[0].name).toBe('a.b')
  })

  it('foreground with and without activity', () => {
    const a = Apps.parseForeground(JSON.parse('{"packageName":"com.x","appName":"X","version":"1","activity":"com.x.Main"}'))!
    expect(a.activity).toBe('com.x.Main')
    const home = Apps.parseForeground(JSON.parse('{"packageName":"com.apple.springboard","appName":"SpringBoard"}'))!
    expect(home.isHome).toBe(true)
    expect(home.activity).toBeUndefined()
    expect(Apps.parseForeground(undefined)).toBeUndefined()
    expect(new ForegroundApp('a', 'a').isHome).toBe(false)
  })

  it('filter matches name or id', () => {
    const apps = Apps.parseList(fixture('mobilecli-apps-list-android.json'))
    expect(Apps.filter(apps, '  ')).toHaveLength(apps.length)
    expect(Apps.filter(apps, 'SETTINGS').find((a) => a.id === 'com.android.settings')).toBeDefined()
    expect(Apps.filter(apps, 'zzzzqq')).toEqual([])
  })

  it('launch args', () => {
    expect(Apps.launchArgs(android, 'a.b')).toEqual(['apps', 'launch', 'a.b'])
    expect(Apps.launchArgs(android, 'a.b', 'fr-FR, en-GB', ' .Main ')).toEqual(['apps', 'launch', 'a.b', '--locale', 'fr-FR,en-GB', '--activity', '.Main'])
    expect(Apps.launchArgs(sim, 'a.b', 'nl-NL', '.Main')).toEqual(['apps', 'launch', 'a.b', '--locale', 'nl-NL'])
  })

  it('clear support', () => {
    expect(Apps.canClearData(android)).toBe(true)
    expect(Apps.canClearData(sim)).toBe(true)
    expect(Apps.canClearData(phone)).toBe(false)
  })

  it('install validation', () => {
    expect(Apps.installProblem(android, '/x/app.APK')).toBeUndefined()
    expect(Apps.installProblem(android, '/x/app.zip')).toBeDefined()
    expect(Apps.installProblem(sim, '/x/App.zip')).toBeUndefined()
    expect(Apps.installProblem(sim, '/x/app.ipa')).toBeDefined()
    expect(Apps.installProblem(phone, '/x/app.ipa')).toBeUndefined()
    expect(Apps.installProblem(phone, '/x/app.zip')).toBeDefined()
    expect(Apps.installProblem(android, '/x/readme.txt')).toBeDefined()
  })

  it('errors', () => {
    expect(Apps.friendlyError('failed: exit status 3')).toContain('not installed')
    expect(Apps.friendlyError('boom')).toBe('boom')
  })

  const settingsApp = appInfo('com.android.settings', 'Settings')
  const mine = appInfo('com.mine.app', 'Mine')

  it('user packages parse pm output', () => {
    const out = 'package:com.mine.app\r\npackage:/data/app/x/base.apk=com.other\nwarning\npackage:\n'
    expect(Apps.parseUserPackages(out)).toEqual(new Set(['com.mine.app', 'com.other']))
    expect(Apps.parseUserPackages('').size).toBe(0)
  })

  it('android system means not user installed', () => {
    const user = new Set(['com.mine.app'])
    expect(Apps.isSystem(android, settingsApp, user)).toBe(true)
    expect(Apps.isSystem(android, mine, user)).toBe(false)
    expect(Apps.isSystem(android, settingsApp, undefined)).toBe(false)
  })

  it('ios system means com apple prefix', () => {
    const apple = appInfo('com.apple.Preferences', 'Settings')
    expect(Apps.isSystem(sim, apple, undefined)).toBe(true)
    expect(Apps.isSystem(phone, apple, undefined)).toBe(true)
    expect(Apps.isSystem(sim, appInfo('com.applesauce.x', 'X'), undefined)).toBe(false)
  })

  it('hideSystem filters keeps the selected one and can be off', () => {
    const apps = [settingsApp, mine]
    const user = new Set(['com.mine.app'])
    expect(Apps.hideSystem(apps, android, user, true)).toEqual([mine])
    expect(Apps.hideSystem(apps, android, user, false)).toEqual(apps)
    expect(Apps.hideSystem(apps, android, user, true, 'com.android.settings')).toEqual(apps)
    expect(Apps.hideSystem(apps, android, undefined, true)).toEqual(apps)
  })

  it('ios fixture hides apple apps', () => {
    const apps = Apps.parseList(fixture('mobilecli-apps-list-ios.json'))
    const shown = Apps.hideSystem(apps, sim, undefined, true)
    expect(shown.length).toBeLessThan(apps.length)
    expect(shown.every((a) => !a.id.startsWith('com.apple.'))).toBe(true)
  })
})
