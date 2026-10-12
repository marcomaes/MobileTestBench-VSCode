// ported-from: core/discovery/DeviceDiscovery.kt
import type { AdbClient } from '../android/adbClient'
import { CommandFailedException, CommandNotFoundException } from '../exec/commandRunner'
import type { MobilecliClient } from '../ios/mobilecliClient'
import type { SimctlClient } from '../ios/simctlClient'
import type { Device } from '../model'
import { OfflineDevices } from '../power/devicePower'
import { AdbDevicesParser, MobilecliDevicesParser, SimctlDevicesParser } from './deviceParsers'
import { isUsable } from '../model'

export interface DiscoveryResult {
  devices: Device[]
  warnings: string[]
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class DeviceDiscovery {
  constructor(
    private readonly adb: AdbClient,
    private readonly simctl: SimctlClient | undefined,
    private readonly mobilecli: MobilecliClient | undefined = undefined,
  ) {}

  async discover(): Promise<DiscoveryResult> {
    const warnings: string[] = []
    const devices: Device[] = []

    try {
      const android = AdbDevicesParser.parse(await this.adb.devicesLongFormat())
      devices.push(...(await Promise.all(android.map((d) => this.enrichAndroid(d)))))
    } catch (e) {
      warnings.push(
        e instanceof CommandNotFoundException
          ? // The process did not start at all: adb is not installed or the configured path is wrong.
            `Android: adb was not found (${this.adb.executable}). Install the Android SDK platform-tools or set the adb path in the Mobile Test Bench settings.`
          : e instanceof CommandFailedException || e instanceof Error
            ? `Android: ${msg(e)}`
            : `Android: ${String(e)}`,
      )
    }

    if (this.simctl) {
      try {
        devices.push(...SimctlDevicesParser.parse(await this.simctl.listBootedJson()))
      } catch (e) {
        warnings.push(`iOS: ${msg(e)}`)
      }
    }

    if (this.mobilecli) {
      try {
        devices.push(...MobilecliDevicesParser.parse(await this.mobilecli.realIosDevicesJson()))
      } catch (e) {
        warnings.push(`iOS devices (mobilecli): ${msg(e)}`)
      }
      try {
        devices.push(...OfflineDevices.missingFrom(devices, await this.mobilecli.devicesIncludingOfflineJson()))
      } catch (e) {
        warnings.push(`Offline devices (mobilecli): ${msg(e)}`)
      }
    }
    return { devices, warnings }
  }

  private async enrichAndroid(device: Device): Promise<Device> {
    if (!isUsable(device)) return device
    const avdName = device.kind === 'EMULATOR' ? await this.adb.avdName(device.id).catch(() => undefined) : undefined
    const name = avdName?.replace(/_/g, ' ')
    const os = await this.adb.osVersion(device.id).catch(() => undefined)
    return { ...device, name: name ?? device.name, osVersion: os, avdName: device.kind === 'EMULATOR' ? avdName : undefined }
  }
}
