// ported-from: DeviceServices.kt
// Only the wiring the foundation needs (discovery, sessions, mobilecli calls). Each Device Tools area adds its own
// factory here, like the Kotlin DeviceServices does.
import { AdbClient } from './core/android/adbClient'
import { AndroidSession } from './core/android/androidSession'
import type { EmulatorLink } from './core/android/emulatorLink'
import { DeviceDiscovery } from './core/discovery/deviceDiscovery'
import { CommandRunner } from './core/exec/commandRunner'
import { ToolLocator } from './core/exec/toolLocator'
import { IosMobilecliSession } from './core/ios/iosMobilecliSession'
import { MobilecliClient } from './core/ios/mobilecliClient'
import { SimctlClient } from './core/ios/simctlClient'
import { MobilecliJson } from './core/mobilecliJson'
import type { Device } from './core/model'
import type { DeviceSession } from './core/session/deviceSession'
import type { Settings } from './settings'

/** Creates the emulator gRPC link of an Android emulator (src/android/grpcEmulatorLink.ts); undefined when unavailable. */
export type EmulatorLinkFactory = (device: Device, adb: AdbClient) => Promise<EmulatorLink | undefined>

/** Wires the editor environment and settings into the editor independent core. */
export class DeviceServices {
  private readonly runner: CommandRunner
  private readonly tools: ToolLocator

  constructor(
    private readonly settings: () => Settings,
    environment: NodeJS.ProcessEnv = process.env,
    private readonly emulatorLinkFactory?: EmulatorLinkFactory,
    tools?: ToolLocator,
  ) {
    this.runner = new CommandRunner(environment)
    this.tools = tools ?? new ToolLocator(environment)
  }

  adbPath(): string {
    return this.settings().adbPath.trim() || this.tools.adb()
  }

  adb(): AdbClient {
    return new AdbClient(this.adbPath(), this.runner)
  }

  simctl(): SimctlClient | undefined {
    return this.tools.isMac ? new SimctlClient(this.tools.xcrun(), this.runner) : undefined
  }

  /** Undefined when mobilecli is not installed: physical iOS devices are then not listed and simulators fall back to simctl + WDA. */
  mobilecli(): MobilecliClient | undefined {
    const exe = this.tools.mobilecli()
    return exe ? new MobilecliClient(exe, this.runner) : undefined
  }

  discovery(): DeviceDiscovery {
    return new DeviceDiscovery(this.adb(), this.simctl(), this.mobilecli())
  }

  /**
   * Runs `mobilecli <args> --device <id>` for [device] (the id is mapped, e.g. emulator-5554 to the AVD name) and returns
   * stdout, normally `{"status":"ok","data":...}`. Throws with mobilecli's own error text on failure.
   */
  async mobilecliCall(device: Device, args: string[], timeoutMs = 20_000): Promise<string> {
    const mobilecli = this.mobilecli()
    if (!mobilecli) throw new Error('mobilecli is required for this feature (npm install -g mobilecli)')
    return mobilecli.call(await MobilecliClient.idFor(device, this.adb()), args, timeoutMs)
  }

  /** Like [mobilecliCall] but returns the envelope's `data` (undefined when there is none). */
  async mobilecliData(device: Device, args: string[], timeoutMs = 20_000): Promise<unknown> {
    return MobilecliJson.data(await this.mobilecliCall(device, args, timeoutMs))
  }

  /** The runner, for tool areas that start long running processes (logs, recordings). */
  commandRunner(): CommandRunner {
    return this.runner
  }

  async createSession(device: Device): Promise<DeviceSession> {
    const mobilecli = this.mobilecli()
    if (device.platform === 'ANDROID') {
      const adb = this.adb()
      const link = device.kind === 'EMULATOR' && this.settings().useEmulatorGrpc ? await this.emulatorLinkFactory?.(device, adb).catch(() => undefined) : undefined
      return new AndroidSession(device, adb, link, this.settings().screenshotIntervalMs, mobilecli)
    }
    if (mobilecli) return new IosMobilecliSession(device, mobilecli)
    // Simulators without mobilecli need IosSimulatorSession (simctl + WebDriverAgent): see docs/PORTING.md.
    throw new Error(
      device.kind === 'SIMULATOR'
        ? 'iOS simulators need mobilecli in this version (npm install -g mobilecli). The simctl + WebDriverAgent fallback is not ported yet.'
        : 'iPhones need mobilecli (npm install -g mobilecli).',
    )
  }
}
