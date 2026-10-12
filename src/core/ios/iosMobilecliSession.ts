// ported-from: core/ios/IosMobilecliSession.kt
import type { Device, DeviceKey, Size } from '../model'
import { FrameOrientation } from '../orientation'
import { MobilecliDeviceInfoParser } from '../discovery/deviceParsers'
import { toFrame, type Frame } from '../image/dimensions'
import { MobilecliDumpParser } from '../inspector/hierarchyParsers'
import type { UiNode } from '../inspector/uiNode'
import { BaseDeviceSession, UnsupportedOperationOnDevice, type FrameListener } from '../session/deviceSession'
import { PollingFrameSource } from '../session/pollingFrameSource'
import type { TransportInfo } from '../session/transportInfo'
import { AgentInstallHint } from './agentInstallHint'
import type { MobilecliClient } from './mobilecliClient'
import { MobilecliMjpegStream } from './mobilecliMjpegStream'

/**
 * iOS device (physical or simulator) through the mobilecli CLI.
 *  - Frames: `mobilecli screencapture -f mjpeg`, falling back to `mobilecli screenshot` polling.
 *  - Input and hierarchy: mobilecli (its on-device agent), coordinates in points.
 */
export class IosMobilecliSession extends BaseDeviceSession {
  private mode = 'mobilecli MJPEG'
  private fallbackReason: string | undefined
  private stream: MobilecliMjpegStream | undefined
  private polling: PollingFrameSource | undefined
  private screenSize: Size | undefined

  constructor(
    readonly device: Device,
    private readonly mobilecli: MobilecliClient,
    private readonly pollIntervalMs = 500,
  ) {
    super()
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

  /** Frames carry the simulator's portrait framebuffer in landscape; the viewer turns them upright when [FrameOrientation.needsUpright] says so. */
  needsUpright(frame: Frame): boolean {
    return FrameOrientation.needsUpright(frame, this.screenSize)
  }

  start(listener: FrameListener): void {
    void this.refreshScreenSize()
    const wrapped: FrameListener = {
      onFrame: (f) => listener.onFrame(f),
      onStatus: (m) => listener.onStatus?.(m),
      onError: (m, cause) => listener.onError(AgentInstallHint.rewrite(m, this.device.id), cause),
    }
    this.stream = new MobilecliMjpegStream(this.mobilecli, this.device.id)
    this.stream.start(wrapped, (frames, error) => {
      this.fallbackReason = error ? `mobilecli MJPEG stream unavailable: ${error}` : frames === 0 ? 'mobilecli MJPEG stream ended without frames' : `mobilecli MJPEG stream ended after ${frames} frames`
      if (frames === 0) wrapped.onStatus?.(`mobilecli stream ${error ? `unavailable (${error})` : 'ended without frames'}, falling back to screenshots`)
      this.mode = 'mobilecli screenshots'
      this.polling = new PollingFrameSource(this.pollIntervalMs, async () => toFrame(await this.mobilecli.screenshotPng(this.device.id)))
      this.polling.start(wrapped)
    })
  }

  private async refreshScreenSize(): Promise<void> {
    try {
      const size = MobilecliDeviceInfoParser.parseScreenSize(await this.mobilecli.deviceInfoJson(this.device.id))
      if (size) this.screenSize = size
    } catch {
      // keep the last known size
    }
  }

  logicalSize(): Size | undefined {
    return this.screenSize
  }

  override refreshSize(): Promise<void> {
    return this.refreshScreenSize()
  }

  tap(x: number, y: number): Promise<void> {
    return this.mobilecli.tap(this.device.id, x, y)
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs = 300): Promise<void> {
    return this.mobilecli.swipe(this.device.id, fromX, fromY, toX, toY, durationMs)
  }

  override longPress(x: number, y: number, durationMs = 700): Promise<void> {
    return this.mobilecli.longPress(this.device.id, x, y, durationMs)
  }

  async press(key: DeviceKey): Promise<void> {
    switch (key) {
      case 'HOME':
      case 'VOLUME_UP':
      case 'VOLUME_DOWN':
        return this.mobilecli.button(this.device.id, key)
      case 'ENTER':
        return this.mobilecli.key(this.device.id, 'enter')
      case 'DELETE':
        return this.mobilecli.key(this.device.id, 'backspace')
      default:
        throw new UnsupportedOperationOnDevice(`${key} is not available through mobilecli on iOS`)
    }
  }

  typeText(text: string): Promise<void> {
    return this.mobilecli.text(this.device.id, text)
  }

  override pressKeys(keys: string[]): Promise<void> {
    return this.mobilecli.keys(this.device.id, keys)
  }

  async hierarchy(): Promise<UiNode> {
    await this.refreshScreenSize() // changes on rotation
    return MobilecliDumpParser.parse(await this.mobilecli.dumpUiJson(this.device.id))
  }

  close(): void {
    this.stream?.close()
    this.stream = undefined
    this.polling?.close()
    this.polling = undefined
  }
}
