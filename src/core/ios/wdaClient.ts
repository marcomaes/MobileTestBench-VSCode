// ported-from: core/ios/WdaClient.kt
import { size, type Size } from '../model'

type FetchFn = typeof fetch

export class WdaException extends Error {
  constructor(
    message: string,
    readonly isInvalidSession: boolean,
  ) {
    super(message)
    this.name = 'WdaException'
  }
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** W3C action payloads, separated for unit testing. */
export const WdaPayloads = {
  tap: (x: number, y: number): Json =>
    pointer([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ]),

  longPress: (x: number, y: number, durationMs: number): Json =>
    pointer([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: durationMs },
      { type: 'pointerUp', button: 0 },
    ]),

  /** Two touches in one action list, so the gap between them is exact instead of two HTTP calls apart. */
  doubleTap: (x: number, y: number): Json =>
    pointer([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 40 },
      { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 40 },
      { type: 'pointerUp', button: 0 },
    ]),

  dragWithHold: (fromX: number, fromY: number, toX: number, toY: number, holdMs: number, durationMs: number): Json =>
    pointer([
      { type: 'pointerMove', duration: 0, x: fromX, y: fromY },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: holdMs },
      { type: 'pointerMove', duration: Math.max(durationMs, 50), x: toX, y: toY },
      { type: 'pointerUp', button: 0 },
    ]),

  swipe: (fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Json =>
    pointer([
      { type: 'pointerMove', duration: 0, x: fromX, y: fromY },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 50 },
      { type: 'pointerMove', duration: Math.max(durationMs, 50), x: toX, y: toY },
      { type: 'pointerUp', button: 0 },
    ]),
}

function pointer(actions: Json[]): Json {
  return { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] }
}

/**
 * Minimal WebDriverAgent client: just what the viewer and inspector need.
 * WDA must already be running for the simulator (via Appium, mobilecli or xcodebuild).
 */
export class WdaClient {
  private readonly base: string
  private sessionId: string | undefined
  private creating: Promise<string> | undefined

  /** [fetchFn] is injectable for tests; it defaults to Node's fetch. */
  constructor(baseUrl: string, private readonly fetchFn: FetchFn = (...args) => fetch(...args)) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  async isReachable(): Promise<boolean> {
    try {
      const [status] = await this.request('GET', '/status', undefined, 3000)
      return status >= 200 && status <= 299
    } catch {
      return false
    }
  }

  /** Window size in points. */
  windowSize(): Promise<Size> {
    return this.withSession(async (id) => {
      const value = (await this.call('GET', `/session/${id}/window/size`)) as Json
      return size(Math.trunc(Number(value.width)), Math.trunc(Number(value.height)))
    })
  }

  /** XML page source of the foreground app. */
  async source(): Promise<string> {
    return String(await this.call('GET', '/source?format=xml', undefined, 60_000))
  }

  tap(x: number, y: number): Promise<void> {
    return this.action(WdaPayloads.tap(x, y))
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    return this.action(WdaPayloads.swipe(fromX, fromY, toX, toY, durationMs))
  }

  longPress(x: number, y: number, durationMs: number): Promise<void> {
    return this.action(WdaPayloads.longPress(x, y, durationMs), holdTimeout(durationMs))
  }

  doubleTap(x: number, y: number): Promise<void> {
    return this.action(WdaPayloads.doubleTap(x, y))
  }

  dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs: number, durationMs: number): Promise<void> {
    return this.action(WdaPayloads.dragWithHold(fromX, fromY, toX, toY, holdMs, durationMs), holdTimeout(holdMs + durationMs))
  }

  private action(payload: Json, timeoutMs = 15_000): Promise<void> {
    return this.withSession(async (id) => {
      await this.call('POST', `/session/${id}/actions`, payload, timeoutMs)
    })
  }

  /** name: home, volumeUp, volumeDown */
  pressButton(name: string): Promise<void> {
    return this.withSession(async (id) => {
      await this.call('POST', `/session/${id}/wda/pressButton`, { name })
    })
  }

  typeText(text: string): Promise<void> {
    return this.withSession(async (id) => {
      await this.call('POST', `/session/${id}/wda/keys`, { value: [text] })
    })
  }

  async close(): Promise<void> {
    const id = this.sessionId
    if (!id) return
    this.sessionId = undefined
    try {
      await this.request('DELETE', `/session/${id}`, undefined, 3000)
    } catch {
      // best effort
    }
  }

  private async withSession<T>(block: (id: string) => Promise<T>): Promise<T> {
    const id = this.sessionId ?? (await this.createSession())
    try {
      return await block(id)
    } catch (e) {
      if (!(e instanceof WdaException) || !e.isInvalidSession) throw e
      return await block(await this.createSession())
    }
  }

  /** One creation at a time (Kotlin: @Synchronized). */
  private createSession(): Promise<string> {
    this.creating ??= this.doCreateSession().finally(() => {
      this.creating = undefined
    })
    return this.creating
  }

  private async doCreateSession(): Promise<string> {
    const body = { capabilities: { alwaysMatch: {}, firstMatch: [{}] } }
    const [status, text] = await this.request('POST', '/session', JSON.stringify(body), 30_000)
    if (status < 200 || status > 299) throw new WdaException(`Could not create WDA session: HTTP ${status} ${text}`, false)
    const json = JSON.parse(text) as Json
    const value = json.value
    const id = typeof json.sessionId === 'string' ? json.sessionId : isObject(value) && typeof value.sessionId === 'string' ? value.sessionId : undefined
    if (!id) throw new WdaException(`WDA did not return a session id: ${text}`, false)
    this.sessionId = id
    return id
  }

  private async call(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const [status, text] = await this.request(method, path, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), timeoutMs)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const value = isObject(json) ? json.value : undefined
    const error = isObject(value) && typeof value.error === 'string' ? value.error : undefined
    if (status < 200 || status > 299 || error !== undefined) {
      const message = isObject(value) && typeof value.message === 'string' ? value.message : text
      throw new WdaException(`WDA ${method} ${path} failed: HTTP ${status} ${error ?? ''} ${message}`.trim(), error === 'invalid session id' || (status === 404 && path.startsWith('/session/')))
    }
    return value ?? {}
  }

  private async request(method: string, path: string, body: string | undefined, timeoutMs: number): Promise<[number, string]> {
    try {
      const response = await this.fetchFn(this.base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      return [response.status, await response.text()]
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause
      if (e instanceof TypeError && (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND' || cause?.code === 'EHOSTUNREACH' || cause?.code === 'ECONNRESET' || cause === undefined)) {
        throw new Error(`WebDriverAgent is not reachable at ${this.base}. Start WDA for this simulator first.`, { cause: e })
      }
      throw e
    }
  }
}

const holdTimeout = (ms: number): number => ms + 15_000
