// ported-from: android/GrpcEmulatorLink.kt
// A local in-process gRPC server stands in for the emulator: streamScreenshot, sendMouse and sendKey are faked, so the
// link is exercised over a real HTTP/2 connection.
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GrpcEmulatorLink, imageToFrame } from '../../src/android/grpcEmulatorLink'
import type { Frame } from '../../src/core/image/dimensions'
import { waitFor } from '../helpers/fakeProcess'

interface Mouse { x: number; y: number; buttons: number; at: number }
interface Key { key: string; text: string; eventType: string }

let server: grpc.Server
let port: number
let mouse: Mouse[]
let keys: Key[]
let auth: (string | Buffer)[]
let streams: grpc.ServerWritableStream<unknown, unknown>[]
let streamRequests: { format?: { format: string } }[]
let failStream: grpc.status | undefined

beforeEach(async () => {
  mouse = []
  keys = []
  auth = []
  streams = []
  streamRequests = []
  failStream = undefined
  const definition = protoLoader.loadSync(join(__dirname, '../../src/proto/emulator_controller.proto'), { keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true })
  const loaded = grpc.loadPackageDefinition(definition) as unknown as { android: { emulation: { control: { EmulatorController: { service: grpc.ServiceDefinition } } } } }
  server = new grpc.Server()
  server.addService(loaded.android.emulation.control.EmulatorController.service, {
    streamScreenshot: (call: grpc.ServerWritableStream<{ format: string }, unknown>) => {
      auth.push(...call.metadata.get('authorization'))
      streamRequests.push({ format: { format: call.request.format as unknown as string } })
      if (failStream !== undefined) return call.emit('error', { code: failStream, details: 'denied' })
      streams.push(call)
      // 2x1 image, RGB888: a red and a blue pixel.
      call.write({ format: { width: 2, height: 1 }, image: Buffer.from([255, 0, 0, 0, 0, 255]) })
    },
    sendMouse: (call: grpc.ServerUnaryCall<Mouse, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      auth.push(...call.metadata.get('authorization'))
      mouse.push({ x: call.request.x, y: call.request.y, buttons: call.request.buttons, at: Date.now() })
      cb(null, {})
    },
    sendKey: (call: grpc.ServerUnaryCall<Key, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      keys.push({ key: call.request.key, text: call.request.text, eventType: call.request.eventType })
      cb(null, {})
    },
  } as unknown as grpc.UntypedServiceImplementation)
  port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))))
})

afterEach(() => {
  server.forceShutdown()
})

const link = (token?: string): GrpcEmulatorLink => new GrpcEmulatorLink({ host: '127.0.0.1', port, token })

describe('grpc emulator link', () => {
  it('streams screenshots as PNG frames and requests RGB888', async () => {
    const l = link()
    const frames: Frame[] = []
    l.startStreaming({ onFrame: (f) => frames.push(f), onError: () => {} })
    expect(await waitFor(() => frames.length === 1)).toBe(true)
    expect(streamRequests[0].format?.format).toBe('RGB888')
    expect(frames[0].mime).toBe('image/png')
    expect([frames[0].width, frames[0].height]).toEqual([2, 1])
    const decoded = PNG.sync.read(frames[0].data)
    expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
    l.close()
  })

  it('drops images with too few bytes', () => {
    expect(imageToFrame({ format: { width: 2, height: 2 }, image: Buffer.alloc(11) })).toBeUndefined()
    expect(imageToFrame({ format: { width: 0, height: 2 }, image: Buffer.alloc(12) })).toBeUndefined()
  })

  it('sends the auth token as a bearer token', async () => {
    const l = link('secret')
    await l.tap(1, 2)
    expect(auth).toEqual(['Bearer secret', 'Bearer secret'])
    l.close()
  })

  it('tap is down, 40 ms, up', async () => {
    const l = link()
    await l.tap(10, 20)
    expect(mouse.map((m) => [m.x, m.y, m.buttons])).toEqual([[10, 20, 1], [10, 20, 0]])
    expect(mouse[1].at - mouse[0].at).toBeGreaterThanOrEqual(35)
    l.close()
  })

  it('long press holds for the duration', async () => {
    const l = link()
    await l.longPress(5, 6, 200)
    expect(mouse.map((m) => m.buttons)).toEqual([1, 0])
    expect(mouse[1].at - mouse[0].at).toBeGreaterThanOrEqual(195)
    l.close()
  })

  it('double tap is two taps 80 ms apart', async () => {
    const l = link()
    await l.doubleTap(3, 4)
    expect(mouse.map((m) => m.buttons)).toEqual([1, 0, 1, 0])
    expect(mouse[2].at - mouse[1].at).toBeGreaterThanOrEqual(75)
    l.close()
  })

  it('swipe moves the held pointer in steps (duration / 16, at least 5) and releases at the end', async () => {
    const l = link()
    await l.swipe(0, 0, 100, 200, 160)
    // down + 10 held moves + up
    expect(mouse).toHaveLength(12)
    expect(mouse[0]).toMatchObject({ x: 0, y: 0, buttons: 1 })
    expect(mouse[10]).toMatchObject({ x: 100, y: 200, buttons: 1 })
    expect(mouse[11]).toMatchObject({ x: 100, y: 200, buttons: 0 })
    expect(mouse[1]).toMatchObject({ x: 10, y: 20, buttons: 1 })
    l.close()
  })

  it('drag with hold waits before it moves', async () => {
    const l = link()
    await l.dragWithHold(0, 0, 10, 10, 150, 80)
    expect(mouse[0].buttons).toBe(1)
    expect(mouse[1].at - mouse[0].at).toBeGreaterThanOrEqual(145)
    expect(mouse.at(-1)).toMatchObject({ x: 10, y: 10, buttons: 0 })
    l.close()
  })

  it('maps keys to W3C names and sends text', async () => {
    const l = link()
    await l.press('HOME')
    await l.press('DELETE')
    await l.typeText('')
    await l.typeText('héllo')
    expect(keys.map((k) => [k.key, k.eventType, k.text])).toEqual([['GoHome', 'keypress', ''], ['Backspace', 'keypress', ''], ['', 'keydown', 'héllo']])
    l.close()
  })

  it('reports a failing stream through onError with the status code', async () => {
    failStream = grpc.status.UNAUTHENTICATED
    const l = link()
    const errors: string[] = []
    l.startStreaming({ onFrame: () => {}, onError: (m) => errors.push(m) })
    expect(await waitFor(() => errors.length === 1)).toBe(true)
    expect(errors[0]).toContain('UNAUTHENTICATED')
    l.close()
  })

  it('a closed link reports no error', async () => {
    const l = link()
    const frames: Frame[] = []
    const errors: string[] = []
    l.startStreaming({ onFrame: (f) => frames.push(f), onError: (m) => errors.push(m) })
    await waitFor(() => frames.length === 1)
    l.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(errors).toEqual([])
  })

  it('an unreachable emulator fails the call', async () => {
    server.forceShutdown()
    const l = link()
    await expect(l.tap(1, 1)).rejects.toThrow()
    l.close()
  })
})
