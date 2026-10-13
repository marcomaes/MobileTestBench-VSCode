// ported-from: test:core/GesturesTest.kt
// ported-from: test:core/StreamAndGeometryTest.kt
import { describe, expect, it } from 'vitest'
import { IosSimulatorSession } from '../../src/core/ios/iosSimulatorSession'
import { SimctlClient } from '../../src/core/ios/simctlClient'
import { WdaClient, WdaPayloads } from '../../src/core/ios/wdaClient'
import { makeDevice } from '../../src/core/model'
import { UnsupportedOperationOnDevice } from '../../src/core/session/deviceSession'
import { fixture } from '../helpers/fixtures'
import { RecordingRunner } from '../helpers/fakeRunner'

function actionTypes(payload: Record<string, unknown>): string[] {
  const pointer = (payload.actions as Record<string, unknown>[])[0]
  return (pointer.actions as Record<string, unknown>[]).map((a) => (a.type as string) + (a.duration !== undefined ? `:${a.duration}` : ''))
}

describe('wda payloads', () => {
  it('wda tap payload is w3c actions', () => {
    const json = JSON.stringify(WdaPayloads.tap(10, 20))
    expect(json).toContain('"pointerType":"touch"')
    expect(json).toContain('"x":10')
    expect(json).toContain('"pointerDown"')
  })

  it('wda long press holds between down and up', () => {
    expect(actionTypes(WdaPayloads.longPress(1, 2, 700))).toEqual(['pointerMove:0', 'pointerDown', 'pause:700', 'pointerUp'])
  })

  it('wda double tap is two touches in one action list', () => {
    expect(actionTypes(WdaPayloads.doubleTap(1, 2))).toEqual(['pointerMove:0', 'pointerDown', 'pause:40', 'pointerUp', 'pause:60', 'pointerDown', 'pause:40', 'pointerUp'])
  })

  it('wda drag with hold pauses before it moves', () => {
    expect(actionTypes(WdaPayloads.dragWithHold(1, 2, 3, 4, 800, 300))).toEqual(['pointerMove:0', 'pointerDown', 'pause:800', 'pointerMove:300', 'pointerUp'])
  })

  it('wda swipe moves for at least 50 ms', () => {
    expect(actionTypes(WdaPayloads.swipe(1, 2, 3, 4, 10))).toEqual(['pointerMove:0', 'pointerDown', 'pause:50', 'pointerMove:50', 'pointerUp'])
  })
})

describe('ios simulator session', () => {
  const device = makeDevice({ id: 'F2368465', name: 'iPhone', platform: 'IOS', kind: 'SIMULATOR' })

  it('ios simulator without WDA supports neither double tap nor hold drag and refuses them', async () => {
    const session = new IosSimulatorSession(device, new SimctlClient('xcrun', new RecordingRunner()), undefined, undefined)
    expect(session.supportsDoubleTap).toBe(false)
    expect(session.supportsHoldDrag).toBe(false)
    await expect(session.doubleTap(1, 2)).rejects.toThrow(/WebDriverAgent/)
    await expect(session.doubleTap(1, 2)).rejects.toBeInstanceOf(UnsupportedOperationOnDevice)
  })

  it('talks to WDA over HTTP: session, tap, keys, window size and source', async () => {
    const calls: { method: string; url: string; body?: string }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body as string | undefined })
      const reply = (value: unknown, status = 200): Response => new Response(JSON.stringify({ value }), { status })
      if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ sessionId: 'S1', value: {} }))
      if (url.endsWith('/window/size')) return reply({ width: 390.5, height: 844 })
      if (url.includes('/source')) return reply(fixture('ios_login.xml'))
      return reply(null)
    }) as unknown as typeof fetch
    const wda = new WdaClient('http://localhost:8100/', fake)
    const session = new IosSimulatorSession(device, new SimctlClient('xcrun', new RecordingRunner()), wda, undefined)
    expect(session.supportsInput && session.supportsDoubleTap && session.supportsHoldDrag).toBe(true)
    await session.tap(10, 20)
    await session.press('HOME')
    await session.press('ENTER')
    await expect(session.press('BACK')).rejects.toBeInstanceOf(UnsupportedOperationOnDevice)
    const root = await session.hierarchy()
    expect([...root.walk()].length).toBeGreaterThan(1)
    expect(session.logicalSize()).toEqual({ width: 390, height: 844 })
    expect(calls.filter((c) => c.url.endsWith('/session') && c.method === 'POST')).toHaveLength(1)
    expect(calls.some((c) => c.url === 'http://localhost:8100/session/S1/actions' && c.body!.includes('"pointerDown"'))).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/wda/pressButton') && c.body === '{"name":"home"}')).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/wda/keys') && c.body === '{"value":["\\n"]}')).toBe(true)
  })

  it('a stale session id is replaced once', async () => {
    let sessions = 0
    const fake = (async (url: string, _init: RequestInit) => {
      if (url.endsWith('/session')) return new Response(JSON.stringify({ value: { sessionId: `S${++sessions}` } }))
      if (url.includes('/session/S1/')) return new Response(JSON.stringify({ value: { error: 'invalid session id', message: 'gone' } }), { status: 404 })
      return new Response(JSON.stringify({ value: null }))
    }) as unknown as typeof fetch
    await new WdaClient('http://x', fake).tap(1, 2)
    expect(sessions).toBe(2)
  })
})
