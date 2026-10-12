// ported-from: core/ios/IosSimulatorSession.kt
import { get } from 'node:http'
import type { Device, DeviceKey, Size } from '../model'
import { toFrame } from '../image/dimensions'
import { WdaSourceParser } from '../inspector/hierarchyParsers'
import type { UiNode } from '../inspector/uiNode'
import { BaseDeviceSession, UnsupportedOperationOnDevice, type FrameListener } from '../session/deviceSession'
import { PollingFrameSource } from '../session/pollingFrameSource'
import type { TransportInfo } from '../session/transportInfo'
import { readMjpegFrames } from './mjpegReader'
import type { SimctlClient } from './simctlClient'
import type { WdaClient } from './wdaClient'

/**
 * iOS simulator.
 *  - Frames: WDA MJPEG stream when available, otherwise `simctl io screenshot` polling.
 *  - Input and hierarchy: WebDriverAgent (required, there is no public simulator input API).
 */
export class IosSimulatorSession extends BaseDeviceSession {
  private mode = 'simctl screenshots'
  private fallbackReason: string | undefined
  private running = false
  private polling: PollingFrameSource | undefined
  private mjpegRequest: { destroy(): void } | undefined
  private windowSize: Size | undefined

  constructor(
    readonly device: Device,
    private readonly simctl: SimctlClient,
    private readonly wda: WdaClient | undefined,
    private readonly mjpegUrl: string | undefined,
    private readonly pollIntervalMs = 400,
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
    return this.wda !== undefined
  }

  start(listener: FrameListener): void {
    this.running = true
    void this.begin(listener)
  }

  private async begin(listener: FrameListener): Promise<void> {
    this.windowSize = await this.wda?.windowSize().catch(() => undefined)
    if (!this.running) return
    if (this.wda && this.mjpegUrl) {
      this.mode = 'WDA MJPEG'
      void this.runMjpeg(listener)
    } else {
      this.fallbackReason = !this.wda ? 'WebDriverAgent not configured: simctl screenshots only, no input or inspection' : 'No WDA MJPEG URL configured'
      this.startPolling(listener)
    }
  }

  private async runMjpeg(listener: FrameListener): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = get(this.mjpegUrl!, { timeout: 3000 }, (response) => {
          request.setTimeout(10_000)
          // The read timeout of the Kotlin connection (10 s without data).
          response.setTimeout(10_000, () => response.destroy(new Error('read timed out')))
          readMjpegFrames(
            response,
            (jpeg) => {
              const frame = toFrame(jpeg)
              if (frame) listener.onFrame(frame)
            },
            () => !this.running,
          ).then(resolve, reject)
        })
        this.mjpegRequest = request
        request.on('timeout', () => request.destroy(new Error('connect timed out')))
        request.on('error', reject)
      })
    } catch (e) {
      if (!this.running) return
      const message = e instanceof Error ? e.message : String(e)
      this.fallbackReason = `WDA MJPEG stream unavailable: ${message}`
      listener.onStatus?.(`MJPEG stream unavailable (${message}), falling back to simctl screenshots`)
    }
    if (this.running) {
      this.mode = 'simctl screenshots'
      this.fallbackReason ??= 'WDA MJPEG stream ended'
      this.startPolling(listener)
    }
  }

  private startPolling(listener: FrameListener): void {
    this.polling = new PollingFrameSource(this.pollIntervalMs, async () => toFrame(await this.simctl.screenshotPng(this.device.id)))
    this.polling.start(listener)
  }

  logicalSize(): Size | undefined {
    return this.windowSize
  }

  private requireWda(): WdaClient {
    if (!this.wda) throw new UnsupportedOperationOnDevice('Input and inspection on iOS need WebDriverAgent. Configure the WDA URL in the extension settings (mobileTestBench.wdaUrl).')
    return this.wda
  }

  async tap(x: number, y: number): Promise<void> {
    await this.requireWda().tap(x, y)
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs = 300): Promise<void> {
    await this.requireWda().swipe(fromX, fromY, toX, toY, durationMs)
  }

  /** WDA W3C pointer actions. Not verified: WebDriverAgent was not available when this was written. */
  override async longPress(x: number, y: number, durationMs = 700): Promise<void> {
    await this.requireWda().longPress(x, y, durationMs)
  }

  override get supportsDoubleTap(): boolean {
    return this.wda !== undefined
  }

  override async doubleTap(x: number, y: number): Promise<void> {
    await this.requireWda().doubleTap(x, y)
  }

  override get supportsHoldDrag(): boolean {
    return this.wda !== undefined
  }

  override async dragWithHold(fromX: number, fromY: number, toX: number, toY: number, holdMs = 700, durationMs = 300): Promise<void> {
    await this.requireWda().dragWithHold(fromX, fromY, toX, toY, holdMs, durationMs)
  }

  async press(key: DeviceKey): Promise<void> {
    const client = this.requireWda()
    switch (key) {
      case 'HOME':
        return client.pressButton('home')
      case 'VOLUME_UP':
        return client.pressButton('volumeUp')
      case 'VOLUME_DOWN':
        return client.pressButton('volumeDown')
      case 'ENTER':
        return client.typeText('\n')
      case 'DELETE':
        return client.typeText('\b')
      case 'BACK':
      case 'APP_SWITCH':
      case 'POWER':
        throw new UnsupportedOperationOnDevice(`${key} is not available on iOS simulators`)
    }
  }

  async typeText(text: string): Promise<void> {
    await this.requireWda().typeText(text)
  }

  async hierarchy(): Promise<UiNode> {
    const client = this.requireWda()
    // Refresh the window size as well, it changes on rotation.
    const refreshed = await client.windowSize().catch(() => undefined)
    if (refreshed) this.windowSize = refreshed
    return WdaSourceParser.parse(await client.source())
  }

  close(): void {
    this.running = false
    this.mjpegRequest?.destroy()
    this.mjpegRequest = undefined
    this.polling?.close()
    this.polling = undefined
    void this.wda?.close()
  }
}
