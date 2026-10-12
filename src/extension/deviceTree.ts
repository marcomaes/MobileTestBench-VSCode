// ported-from: ui/DeviceToolWindowFactory.kt
import * as vscode from 'vscode'
import { displayName, isUsable, type Device } from '../core/model'
import type { DeviceServices } from '../deviceServices'

class DeviceItem extends vscode.TreeItem {
  constructor(readonly device: Device) {
    super(device.name, vscode.TreeItemCollapsibleState.None)
    this.description = [device.osVersion, device.kind.toLowerCase(), device.bootable ? 'offline' : isUsable(device) ? '' : device.state].filter(Boolean).join(' · ')
    this.tooltip = displayName(device)
    this.iconPath = new vscode.ThemeIcon(device.platform === 'ANDROID' ? 'device-mobile' : 'device-mobile')
    this.contextValue = device.bootable ? 'device.offline' : 'device'
    this.command = { command: 'mobileTestBench.openDevice', title: 'Open Device', arguments: [device] }
  }
}

/** The Devices view: every device discovery finds. */
export class DeviceTree implements vscode.TreeDataProvider<DeviceItem | vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private devices: Device[] = []
  private warnings: string[] = []

  constructor(private readonly services: DeviceServices) {}

  async refresh(): Promise<void> {
    const result = await this.services.discovery().discover()
    this.devices = result.devices
    this.warnings = result.warnings
    this.changed.fire()
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = this.devices.map((d) => new DeviceItem(d))
    for (const w of this.warnings) {
      const item = new vscode.TreeItem(w, vscode.TreeItemCollapsibleState.None)
      item.iconPath = new vscode.ThemeIcon('warning')
      items.push(item)
    }
    return items
  }
}
