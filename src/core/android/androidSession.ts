// ported-from: core/android/AndroidSession.kt
import { sizeEquals, sizeIsLandscape, sizeSwapped, type Device, type DeviceKey, type Size } from '../model'
import { toFrame, type Frame } from '../image/dimensions'
import { MobilecliAndroidRawParser, UiAutomatorParser } from '../inspector/hierarchyParsers'
import type { UiNode } from '../inspector/uiNode'
import { MobilecliClient } from '../ios/mobilecliClient'
import { MobilecliMjpegStream } from '../ios/mobilecliMjpegStream'
import { BaseDeviceSession, UnsupportedOperationOnDevice, type FrameListener } from '../session/deviceSession'
import { PollingFrameSource } from '../session/pollingFrameSource'
import type { TransportInfo } from '../session/transportInfo'
import { AdbClient, KEYCODE } from './adbClient'
import type { EmulatorLink } from './emulatorLink'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Android device or emulator. When an [EmulatorLink] is available (emulator with gRPC), frames and input go through
 * it; otherwise adb screenshots and `adb shell input` are used. The hierarchy comes from `mobilecli dump ui` when it is
 * installed, otherwise (or when that fails) from uiautomator via adb.
 */
export class AndroidSession extends BaseDeviceSession {
  /** Set to undefined when the gRPC link fails before delivering a frame, so adb takes over. */
  private link: EmulatorLink | undefined
  private mode: string
  private fallbackReason: string | undefined
  private displaySize: Size | undefined
  private lastFrameSize: Size | undefined
  private gotLinkFrame = false
  private polling: PollingFrameSource | undefined
  private stream: MobilecliMjpegStream | undefined
  private displayWatcher: ReturnType<typeof setInterval> | undefined
  private cachedDensity: number | undefined
  private mobilecliIdPromise: Promise<string> | undefined
  private closed = false

  constructor(
    readonly device: Device,
    private readonly adb: AdbClient,
    emulatorLink: EmulatorLink | undefined,
    private readonly pollIntervalMs = 250,
    private readonly mobilecli: MobilecliClient | undefined = undefined,
    private readonly displayWatchMs = 2000,
  ) {
    super()
    this.link = emulatorLink
    this.mode = emulatorLink ? 'emulator gRPC' : 'adb screenshots'
  }

  get transport(): string {
    return this.mode
  }
  override transportInfo(): TransportInfo {
    return { name: this.mode, fallbackReason: this.fallbackReason }
  }
  get supportsInput(): boolean {
    return true
  }

  start(listener: FrameListener): void {
    void this.begin(listener)
  }

  private async begin(listener: FrameListener): Promise<void> {
    this.displaySize = await this.adb.displaySize(this.device.id).catch(() => undefined)
    const tracking: FrameListener = {
      onFrame: (f: Frame) => {
        this.lastFrameSize = { width: f.width, height: f.height }
        listener.onFrame(f)
      },
      onStatus: (m) => listener.onStatus?.(m),
      onError: (m, cause) => listener.onError(m, cause),
    }
    const current = this.link
    if (!current) {
      this.fallbackReason = 'No emulator gRPC link (not an emulator, gRPC unavailable or disabled in settings)'
      this.startFallback(tracking)
      return
    }
    current.startStreaming({
      onFrame: (f) => {
        this.gotLinkFrame = true
        tracking.onFrame(f)
      },
      onStatus: (m) => tracking.onStatus?.(m),
      onError: (m, cause) => {
        if (this.gotLinkFrame) {
          tracking.onError(m, cause)
          return
        }
        // e.g. the emulator requires JWT auth or was started without gRPC.
        this.link = undefined
        this.fallbackReason = `gRPC failed before the first frame: ${m}`
        try {
          current.close()
        } catch {
          // already closed
        }
        tracking.onStatus?.(`${m}. Falling back to ${this.mobilecli ? 'the mobilecli stream' : 'adb screenshots'}.`)
        this.startFallback(tracking)
      },
    })
  }

  /** The mobilecli MJPEG stream when installed (fast, also on physical phones), adb screenshots when it is missing or fails. */
  private startFallback(listener: FrameListener): void {
    if (this.closed) return
    const client = this.mobilecli
    if (!client) return this.startPolling(listener)
    this.mode = 'mobilecli MJPEG'
    const previousReason = this.fallbackReason
    void this.openStream(client, listener, previousReason)
    this.watchDisplay(client, listener, previousReason)
  }

  private async openStream(client: MobilecliClient, listener: FrameListener, previousReason: string | undefined): Promise<void> {
    const id = await this.mobilecliId()
    if (this.closed) return
    this.stream = new MobilecliMjpegStream(client, id)
    this.stream.start(listener, (frames, error) => {
      const why = error ? `unavailable: ${error}` : frames === 0 ? 'ended without frames' : `ended after ${frames} frames`
      this.fallbackReason = [previousReason, `mobilecli MJPEG stream ${why}`].filter(Boolean).join('; ')
      listener.onStatus?.(`mobilecli stream ${why}, falling back to adb screenshots`)
      this.startPolling(listener)
    })
  }

  /**
   * A foldable switches displays when it folds, but mobilecli's capture display keeps the size it was created with, so
   * the stream would show the old display. `wm size` follows the active display (not the rotation): restart the stream
   * when it changes.
   */
  private watchDisplay(client: MobilecliClient, listener: FrameListener, previousReason: string | undefined): void {
    let busy = false
    this.displayWatcher = setInterval(() => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          const size = await this.adb.displaySize(this.device.id).catch(() => undefined)
          if (!size || sizeEquals(size, this.displaySize)) return
          const known = this.displaySize !== undefined
          this.displaySize = size
          if (!known || this.mode !== 'mobilecli MJPEG' || this.closed) return
          this.stream?.close()
          listener.onStatus?.(`Display changed to ${size.width}x${size.height}, restarting the stream`)
          await this.openStream(client, listener, previousReason)
        } finally {
          busy = false
        }
      })()
    }, this.displayWatchMs)
  }

  private startPolling(listener: FrameListener): void {
    if (this.closed) return
    this.mode = 'adb screenshots'
    this.polling = new PollingFrameSource(this.pollIntervalMs, async () => toFrame(await this.adb.screencapPng(this.device.id)))
    this.polling.start(listener)
  }

  /** `wm density`, read once (a later change needs a reconnect). A failed read is retried on the next call. */
  override async density(): Promise<number | undefined> {
    if (this.cachedDensity !== undefined) return this.cachedDensity
    this.cachedDensity = await this.adb.displayDensity(this.device.id).catch(() => undefined)
    return this.cachedDensity
  }

  /** Display pixels, oriented like the most recent frame (handles rotation). */
  logicalSize(): Size | undefined {
    const frame = this.lastFrameSize
    const display = this.displaySize
    if (!display) return frame
    if (!frame) return display
    return sizeIsLandscape(frame) !== sizeIsLandscape(display) ? sizeSwapped(display) : display
  }

  tap(x: number, y: number): Promise<void> {
    return this.link ? this.link.tap(x, y) : this.adb.tap(this.device.id, x, y)
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs = 300): Promise<void> {
    return this.link ? this.link.swipe(fromX, fromY, toX, toY, durationMs) : this.adb.swipe(this.device.id, fromX, fromY, toX, toY, durationMs)
  }

  /** gRPC holds the pointer down; without it adb sends a swipe that starts and ends at the same point. */
  override longPress(x: number, y: number, durationMs = 700): Promise<void> {
    return this.link ? this.link.longPress(x, y, durationMs) : this.adb.swipe(this.device.id, x, y, x, y, durationMs)
  }

  /** Only gRPC is fast enough: each adb or mobilecli call costs 150 ms or more, past the 300 ms double tap timeout, so they would be two single taps. */
  override get supportsDoubleTap(): boolean {
    return this.link !== undefined
  }

  override async doubleTap(x: number, y: number): Promise<void> {
    if (!this.link) throw new UnsupportedOperationOnDevice('Double tap on Android needs the emulator gRPC connection: adb and mobilecli are too slow for the double tap timeout')
    await this.link.doubleTap(x, y)
  }

  override get supportsHoldDrag(): boolean {
    return this.link !== undefined
  }

  override async dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs = 700, durationMs = 300): Promise<void> {
    if (!this.link) throw new UnsupportedOperationOnDevice('Drag with hold on Android needs the emulator gRPC connection')
    await this.link.dragWithHold(fromX, fromY, toX, toY, holdMs, durationMs)
  }

  async press(key: DeviceKey): Promise<void> {
    if (this.link) return this.link.press(key)
    const code = {
      HOME: KEYCODE.HOME,
      BACK: KEYCODE.BACK,
      APP_SWITCH: KEYCODE.APP_SWITCH,
      ENTER: KEYCODE.ENTER,
      DELETE: KEYCODE.DEL,
      VOLUME_UP: KEYCODE.VOLUME_UP,
      VOLUME_DOWN: KEYCODE.VOLUME_DOWN,
      POWER: KEYCODE.POWER,
    }[key]
    await this.adb.keyEvent(this.device.id, code)
  }

  typeText(text: string): Promise<void> {
    return this.link ? this.link.typeText(text) : this.adb.text(this.device.id, text)
  }

  /** mobilecli when installed (one call); otherwise adb for the two keys select-all and backspace need. */
  override async pressKeys(keys: string[]): Promise<void> {
    if (this.mobilecli) return this.mobilecli.keys(await this.mobilecliId(), keys)
    for (const key of keys) {
      if (key === 'ctrl+a') await this.adb.keyCombination(this.device.id, KEYCODE.CTRL_LEFT, KEYCODE.A)
      else if (key === 'backspace') await this.adb.keyEvent(this.device.id, KEYCODE.DEL)
      else throw new UnsupportedOperationOnDevice(`Key ${key} needs mobilecli on Android`)
    }
  }

  /**
   * mobilecli first when installed: its dump takes about 0.1 s, while `uiautomator dump` is killed on some emulator
   * images (exit 137) and costs time on every attempt. uiautomator is the fallback.
   */
  async hierarchy(): Promise<UiNode> {
    if (this.mobilecli) {
      try {
        return MobilecliAndroidRawParser.parse(await this.mobilecli.dumpUiRawJson(await this.mobilecliId()))
      } catch (e) {
        void message(e) // fall through to uiautomator; its error is the one to report
      }
    }
    return UiAutomatorParser.parse(await this.adb.dumpHierarchy(this.device.id))
  }

  /** mobilecli names an emulator by its AVD name, not by the adb serial. */
  private mobilecliId(): Promise<string> {
    this.mobilecliIdPromise ??= MobilecliClient.idFor(this.device, this.adb)
    return this.mobilecliIdPromise
  }

  close(): void {
    this.closed = true
    if (this.displayWatcher) clearInterval(this.displayWatcher)
    this.displayWatcher = undefined
    this.stream?.close()
    this.stream = undefined
    this.polling?.close()
    this.polling = undefined
    this.link?.close()
  }
}
