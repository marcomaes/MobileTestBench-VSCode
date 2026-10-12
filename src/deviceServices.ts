// ported-from: DeviceServices.kt
// Only the wiring the foundation needs (discovery, sessions, mobilecli calls). Each Device Tools area adds its own
// factory here, like the Kotlin DeviceServices does.
import { homedir, platform } from 'node:os'
import { GrpcEmulatorLink } from './android/grpcEmulatorLink'
import { AdbClient } from './core/android/adbClient'
import { AndroidSession } from './core/android/androidSession'
import type { EmulatorLink } from './core/android/emulatorLink'
import { EmulatorDiscovery } from './core/android/emulatorDiscovery'
import { AndroidBattery } from './core/battery/battery'
import { AndroidBiometrics, IosBiometrics } from './core/biometrics/biometrics'
import { AndroidDisplay, IosDisplay, type DisplayBackend } from './core/display/display'
import { AndroidLocale, IosLocale, type LocaleBackend } from './core/display/locale'
import { AndroidFiles, FilesException, IosFiles, type FileBackend } from './core/files/files'
import { InputActions } from './core/input/input'
import { ScreenRecording } from './core/recording/screenRecording'
import { AndroidMemory } from './core/memory/memory'
import { AndroidNetwork } from './core/network/network'
import { DeviceDiscovery } from './core/discovery/deviceDiscovery'
import { CommandRunner } from './core/exec/commandRunner'
import { AndroidPackages } from './core/apps/apps'
import { AndroidLogParser, IosLogParser, type LogEntry } from './core/logs/logs'
import { LogStream } from './core/logs/logStream'
import { MobilecliLogParser } from './core/logs/mobilecliLogParser'
import { AndroidNotifications, IosNotifications } from './core/notifications/notificationBackends'
import { AndroidPermissions, IosPermissions } from './core/permissions/permissions'
import { ToolLocator } from './core/exec/toolLocator'
import { IosMobilecliSession } from './core/ios/iosMobilecliSession'
import { IosSimulatorSession } from './core/ios/iosSimulatorSession'
import { WdaClient } from './core/ios/wdaClient'
import { MobilecliClient } from './core/ios/mobilecliClient'
import { SimctlClient } from './core/ios/simctlClient'
import { MobilecliJson } from './core/mobilecliJson'
import type { Device } from './core/model'
import { AndroidPerf, IosPerf, type PerfBackend } from './core/perf/perfBackends'
import type { DeviceSession } from './core/session/deviceSession'
import type { Settings } from './settings'

/** Creates the emulator gRPC link of an Android emulator (src/android/grpcEmulatorLink.ts); undefined when unavailable. */
export type EmulatorLinkFactory = (device: Device, adb: AdbClient) => Promise<EmulatorLink | undefined>

/**
 * The default [EmulatorLinkFactory]: finds the emulator's `pid_<pid>.ini` (EmulatorDiscovery) and opens the gRPC link.
 * [environment] is the editor's (shell) environment, like Kotlin's EnvironmentUtil.
 */
export const createGrpcLink =
  (environment: NodeJS.ProcessEnv = process.env): EmulatorLinkFactory =>
  async (device) => {
    const dirs = EmulatorDiscovery.defaultDirectories(environment, platform(), homedir())
    const endpoint = await EmulatorDiscovery.findEndpoint(device.id, dirs)
    if (!endpoint) return undefined
    try {
      return new GrpcEmulatorLink(endpoint)
    } catch {
      return undefined
    }
  }

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

  /**
   * The Performance tab's backend: Android through adb, iOS simulators through the Mac side (launchctl, footprint, ps, the simulator log).
   * Undefined for physical iPhones. The home button of a warm iOS start goes through mobilecli, so call `measure` only with it installed.
   */
  perf(device: Device): PerfBackend | undefined {
    if (device.platform === 'ANDROID') return new AndroidPerf(this.adbPath(), device.id, this.runner)
    if (device.kind === 'SIMULATOR' && this.tools.isMac) {
      return new IosPerf(this.tools.xcrun(), device.id, this.runner, async () => {
        await this.mobilecliCall(device, ['io', 'button', 'HOME'])
      })
    }
    return undefined
  }

  /** The Display tab's backend for [device]: adb for Android, `simctl ui` for iOS simulators. Undefined for physical iPhones (nothing to call). */
  display(device: Device): DisplayBackend | undefined {
    if (device.platform === 'ANDROID') return new AndroidDisplay(this.adbPath(), device.id, this.runner)
    if (device.kind === 'SIMULATOR' && this.tools.isMac) return new IosDisplay(this.tools.xcrun(), device.id, this.runner)
    return undefined
  }

  /** The language and time zone backend of the Display tab: adb for Android, `simctl spawn defaults` for iOS simulators. */
  locale(device: Device): LocaleBackend | undefined {
    if (device.platform === 'ANDROID') return new AndroidLocale(this.adbPath(), device.id, this.runner)
    if (device.kind === 'SIMULATOR' && this.tools.isMac) return new IosLocale(this.tools.xcrun(), device.id, this.runner)
    return undefined
  }

  /** The Input tab's actions for [device]. Maps the mobilecli id (an adb call for emulators). */
  async input(device: Device): Promise<InputActions> {
    const mobilecli = this.mobilecli()
    return new InputActions(
      device.platform,
      device.id,
      this.runner,
      device.platform === 'ANDROID' ? this.adbPath() : undefined,
      device.platform === 'IOS' && device.kind === 'SIMULATOR' && this.tools.isMac ? this.tools.xcrun() : undefined,
      mobilecli,
      mobilecli ? await MobilecliClient.idFor(device, this.adb()) : undefined,
    )
  }

  /** The Battery tab's backend: Android only (adb `dumpsys battery`). */
  battery(device: Device): AndroidBattery | undefined {
    return device.platform === 'ANDROID' ? new AndroidBattery(this.adbPath(), device.id, this.runner) : undefined
  }

  /** The memory warning backend of the Battery tab: Android only (`am send-trim-memory`). */
  memory(device: Device): AndroidMemory | undefined {
    return device.platform === 'ANDROID' ? new AndroidMemory(this.adbPath(), device.id, this.runner) : undefined
  }

  /** The Network tab's backend: Android only (adb); the speed and latency part is enabled for emulators (serial emulator-NNNN). */
  network(device: Device): AndroidNetwork | undefined {
    return device.platform === 'ANDROID' ? new AndroidNetwork(this.adbPath(), device.id, this.runner, EmulatorDiscovery.consolePort(device.id) !== undefined) : undefined
  }

  /** The Biometrics tab's Android backend (emulators only: `adb emu`). */
  androidBiometrics(device: Device): AndroidBiometrics | undefined {
    return device.platform === 'ANDROID' && EmulatorDiscovery.consolePort(device.id) !== undefined ? new AndroidBiometrics(this.adbPath(), device.id, this.runner) : undefined
  }

  /** The Biometrics tab's iOS backend (simulators on macOS). */
  iosBiometrics(device: Device): IosBiometrics | undefined {
    return this.tools.isMac && device.platform === 'IOS' && device.kind === 'SIMULATOR' ? new IosBiometrics(this.tools.xcrun(), device.id, this.runner) : undefined
  }

  /**
   * The Files tab's backend for [device]: device storage ([appId] undefined) or an app's data. Android uses adb (`run-as` for app data, debuggable apps
   * only); iOS simulators use `mobilecli fs` with host paths. Resolves the iOS root, so it is async; throws [FilesException] when
   * the device has no file access (physical iPhones are not supported) or the app has no data container.
   */
  async files(device: Device, appId: string | undefined): Promise<FileBackend> {
    if (device.platform === 'ANDROID') return new AndroidFiles(this.adbPath(), device.id, this.runner, appId)
    if (device.kind === 'SIMULATOR' && this.tools.isMac && this.mobilecli()) {
      const call = (args: string[]) => this.mobilecliCall(device, args, 5 * 60_000)
      const root = appId === undefined ? await IosFiles.deviceRoot(call) : await IosFiles.appContainer(this.runner, this.tools.xcrun(), device.id, appId)
      return new IosFiles(call, root, appId)
    }
    if (device.platform === 'IOS' && device.kind === 'SIMULATOR') throw new FilesException('Files on an iOS simulator need mobilecli (npm install -g mobilecli)')
    throw new FilesException('Files supports Android devices and iOS simulators, not physical iPhones')
  }

  /** Starts recording the device screen to [output] (MP4). Needs mobilecli. Resolves after about a second. */
  async startScreenRecording(device: Device, output: string): Promise<ScreenRecording> {
    const mobilecli = this.mobilecli()
    if (!mobilecli) throw new Error('mobilecli is required for screen recording (npm install -g mobilecli)')
    return ScreenRecording.start(this.runner, mobilecli.screenRecordCommand(await MobilecliClient.idFor(device, this.adb()), output), output)
  }

  /**
   * Starts the live device log: `adb logcat` on Android, `log stream` on a simulator. Undefined for devices without a log source
   * (physical iPhones without mobilecli); a physical iPhone uses `mobilecli device logs`.
   */
  startLog(device: Device, onEntry: (entry: LogEntry) => void, onEnd: (error: string | undefined) => void): LogStream | undefined {
    if (device.platform === 'ANDROID') return LogStream.start(() => this.runner.start(this.adb().logcatCommand(device.id)), (l) => AndroidLogParser.parse(l), onEntry, onEnd)
    if (device.kind === 'SIMULATOR') {
      const simctl = this.simctl()
      return simctl ? LogStream.start(() => this.runner.start(simctl.logStreamCommand(device.id)), (l) => IosLogParser.parse(l), onEntry, onEnd) : undefined
    }
    // A physical iPhone has no adb/simctl log: mobilecli is the only source (experimental, see logSourceNote).
    const cli = this.mobilecli()
    return cli ? LogStream.start(() => this.runner.start(cli.logsCommand(device.id)), (l) => MobilecliLogParser.parse(l), onEntry, onEnd) : undefined
  }

  /** A caveat to show next to the log of [device] (undefined when the source is the normal one). */
  logSourceNote(device: Device): string | undefined {
    return device.platform === 'IOS' && device.kind !== 'SIMULATOR' ? 'via mobilecli (experimental, not verified on a physical iPhone)' : undefined
  }

  /** The process ids of an Android app (to show only its log lines). Empty when it is not running. */
  androidPids(device: Device, packageName: string): Promise<Set<string>> {
    return this.adb().pidsOf(device.id, packageName)
  }

  /** The Notifications tab's iOS backend (simulators on macOS: `simctl push`). */
  iosNotifications(device: Device): IosNotifications | undefined {
    return this.tools.isMac && device.platform === 'IOS' && device.kind === 'SIMULATOR' ? new IosNotifications(this.tools.xcrun(), device.id, this.runner) : undefined
  }

  /** The Notifications tab's Android backend (adb shell, one remote quoted command string per call). */
  androidNotifications(device: Device): AndroidNotifications | undefined {
    return device.platform === 'ANDROID' ? new AndroidNotifications(this.adbPath(), device.id, this.runner) : undefined
  }

  /** User installed packages of an Android [device] (adb), to tell system apps apart. */
  androidPackages(device: Device): AndroidPackages {
    return new AndroidPackages(this.adbPath(), device.id, this.runner)
  }

  /** Android runtime permissions of apps on [device] (adb). */
  androidPermissions(device: Device): AndroidPermissions {
    return new AndroidPermissions(this.adbPath(), device.id, this.runner)
  }

  /** Privacy services of apps on an iOS simulator; undefined when not on macOS or [device] is not a simulator. */
  iosPermissions(device: Device): IosPermissions | undefined {
    return this.tools.isMac && device.platform === 'IOS' && device.kind === 'SIMULATOR' ? new IosPermissions(this.tools.xcrun(), device.id, this.runner) : undefined
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
    if (device.kind === 'PHYSICAL') throw new Error('mobilecli is required for physical iOS devices (npm install -g mobilecli)')
    const simctl = this.simctl()
    if (!simctl) throw new Error('iOS simulators are only available on macOS')
    const settings = this.settings()
    const wdaUrl = settings.wdaUrl?.trim()
    const candidate = wdaUrl ? new WdaClient(wdaUrl) : undefined
    const wda = candidate && (await candidate.isReachable()) ? candidate : undefined
    const mjpeg = settings.mjpegUrl?.trim() && wda ? settings.mjpegUrl : undefined
    return new IosSimulatorSession(device, simctl, wda, mjpeg)
  }
}
