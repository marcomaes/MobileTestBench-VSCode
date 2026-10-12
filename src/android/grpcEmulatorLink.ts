// ported-from: android/GrpcEmulatorLink.kt
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { EmulatorGrpcEndpoint } from '../core/android/emulatorDiscovery'
import type { EmulatorLink } from '../core/android/emulatorLink'
import type { Frame } from '../core/image/dimensions'
import type { DeviceKey } from '../core/model'
import type { FrameListener } from '../core/session/deviceSession'

/** Between the two taps of a double tap; Android's timeout is 300 ms from the first up to the second down. */
const DOUBLE_TAP_GAP_MS = 80

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Finds src/proto (vitest, ts-node) or dist/proto (esbuild copies it next to dist/extension.js). */
function protoPath(): string {
  for (const dir of [join(__dirname, 'proto'), join(__dirname, '..', 'proto')]) {
    const file = join(dir, 'emulator_controller.proto')
    if (existsSync(file)) return file
  }
  throw new Error('emulator_controller.proto not found next to the extension')
}

interface ImageMessage {
  format?: { width?: number; height?: number }
  image?: Buffer
}

type Unary<Req> = (req: Req, metadata: grpc.Metadata, options: grpc.CallOptions, cb: (err: grpc.ServiceError | null) => void) => grpc.ClientUnaryCall

interface EmulatorControllerClient extends grpc.Client {
  streamScreenshot(req: object, metadata: grpc.Metadata): grpc.ClientReadableStream<ImageMessage>
  sendMouse: Unary<object>
  sendKey: Unary<object>
}

type ClientConstructor = new (address: string, credentials: grpc.ChannelCredentials, options?: object) => EmulatorControllerClient

let cachedConstructor: ClientConstructor | undefined
function clientConstructor(): ClientConstructor {
  if (!cachedConstructor) {
    const definition = protoLoader.loadSync(protoPath(), { keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true })
    const loaded = grpc.loadPackageDefinition(definition) as unknown as { android: { emulation: { control: { EmulatorController: ClientConstructor } } } }
    cachedConstructor = loaded.android.emulation.control.EmulatorController
  }
  return cachedConstructor
}

/**
 * Raw RGB888 pixels as an encoded PNG (a [Frame] holds encoded bytes). Compression level 1: the emulator can stream
 * 60 frames a second and the bytes only travel to the webview.
 */
export function rgbToPng(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Same as the Kotlin toBufferedImage: null when the size is not positive or the bytes are fewer than width * height * 3. */
export function imageToFrame(value: ImageMessage): Frame | undefined {
  const width = value.format?.width ?? 0
  const height = value.format?.height ?? 0
  const bytes = value.image
  if (width <= 0 || height <= 0 || !bytes || bytes.length < width * height * 3) return undefined
  return { data: rgbToPng(bytes, width, height), mime: 'image/png', width, height }
}

/**
 * Talks to the emulator's EmulatorController gRPC service (the same API Android Studio's
 * Running Devices window uses): streamScreenshot for frames, sendMouse/sendKey for input.
 */
export class GrpcEmulatorLink implements EmulatorLink {
  private readonly client: EmulatorControllerClient
  private readonly metadata = new grpc.Metadata()
  private streamCall: grpc.ClientReadableStream<ImageMessage> | undefined
  private closed = false

  constructor(endpoint: EmulatorGrpcEndpoint) {
    // The emulator's optional auth token (grpc.token in its pid_*.ini) travels as a bearer token on every call,
    // like the Kotlin BearerTokenInterceptor. A JWT protected emulator (Android Studio's own keys) is not supported
    // and fails with UNAUTHENTICATED, after which AndroidSession falls back to adb.
    if (endpoint.token) this.metadata.set('authorization', `Bearer ${endpoint.token}`)
    this.client = new (clientConstructor())(`${endpoint.host}:${endpoint.port}`, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': 128 * 1024 * 1024,
    })
  }

  startStreaming(listener: FrameListener): void {
    // Width/height 0 means native display resolution, already rotated correctly.
    const call = this.client.streamScreenshot({ format: 'RGB888' }, this.metadata)
    this.streamCall = call
    call.on('data', (value: ImageMessage) => {
      const frame = imageToFrame(value)
      if (frame) listener.onFrame(frame)
    })
    call.on('error', (e: grpc.ServiceError) => {
      if (this.closed || e.code === grpc.status.CANCELLED) return
      const code = grpc.status[e.code] ?? String(e.code)
      const description = e.details ? `: ${e.details}` : ''
      listener.onError(`Emulator gRPC stream failed (${code}${description})`, e)
    })
    call.on('end', () => {
      if (!this.closed) listener.onStatus?.('Emulator stream ended')
    })
  }

  async tap(x: number, y: number): Promise<void> {
    await this.mouse(x, y, 1)
    await sleep(40)
    await this.mouse(x, y, 0)
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    await this.mouse(fromX, fromY, 1)
    await this.moveHeld(fromX, fromY, toX, toY, durationMs)
    await this.mouse(toX, toY, 0)
  }

  async longPress(x: number, y: number, durationMs: number): Promise<void> {
    await this.mouse(x, y, 1)
    await sleep(durationMs)
    await this.mouse(x, y, 0)
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y)
    await sleep(DOUBLE_TAP_GAP_MS)
    await this.tap(x, y)
  }

  async dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs: number, durationMs: number): Promise<void> {
    await this.mouse(fromX, fromY, 1)
    await sleep(holdMs)
    await this.moveHeld(fromX, fromY, toX, toY, durationMs)
    await this.mouse(toX, toY, 0)
  }

  /** Moves the held pointer from one point to the other in small steps over [durationMs]. */
  private async moveHeld(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    const steps = Math.min(Math.max(Math.trunc(durationMs / 16), 5), 120)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await this.mouse(Math.trunc(fromX + (toX - fromX) * t), Math.trunc(fromY + (toY - fromY) * t), 1)
      await sleep(Math.trunc(durationMs / steps))
    }
  }

  async press(key: DeviceKey): Promise<void> {
    // W3C KeyboardEvent.key values, understood by the emulator.
    const name = {
      HOME: 'GoHome',
      BACK: 'GoBack',
      APP_SWITCH: 'AppSwitch',
      ENTER: 'Enter',
      DELETE: 'Backspace',
      VOLUME_UP: 'AudioVolumeUp',
      VOLUME_DOWN: 'AudioVolumeDown',
      POWER: 'Power',
    }[key]
    await this.unary(this.client.sendKey, { eventType: 'keypress', key: name })
  }

  async typeText(text: string): Promise<void> {
    if (text === '') return
    await this.unary(this.client.sendKey, { text })
  }

  close(): void {
    this.closed = true
    this.streamCall?.cancel()
    this.streamCall = undefined
    this.client.close()
  }

  private mouse(x: number, y: number, buttons: number): Promise<void> {
    return this.unary(this.client.sendMouse, { x, y, buttons })
  }

  /** Every unary call has a 3 second deadline, like the Kotlin blocking stub. */
  private unary(method: Unary<object>, request: object): Promise<void> {
    return new Promise((resolve, reject) => {
      method.call(this.client, request, this.metadata, { deadline: Date.now() + 3000 }, (err) => (err ? reject(new Error(`${grpc.status[err.code] ?? err.code}: ${err.details || err.message}`)) : resolve()))
    })
  }
}
