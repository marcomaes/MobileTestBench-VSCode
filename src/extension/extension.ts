// ported-from: ui/DeviceToolWindowFactory.kt
import * as vscode from 'vscode'
import { DeviceServices } from '../deviceServices'
import type { Device } from '../core/model'
import { DeviceTree } from './deviceTree'
import { DeviceViewer } from './deviceViewer'
import { readSettings } from './settings'

export function activate(context: vscode.ExtensionContext): void {
  const services = new DeviceServices(readSettings, shellEnvironment())
  const tree = new DeviceTree(services)

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mobileTestBench.devices', tree),
    vscode.commands.registerCommand('mobileTestBench.refreshDevices', () => tree.refresh()),
    vscode.commands.registerCommand('mobileTestBench.openDevice', async (device?: Device) => {
      if (!device) {
        const found = (await services.discovery().discover()).devices
        const pick = await vscode.window.showQuickPick(
          found.map((d) => ({ label: d.name, description: d.osVersion, detail: d.kind.toLowerCase(), device: d })),
          { placeHolder: 'Select a device' },
        )
        device = pick?.device
      }
      if (device) DeviceViewer.show(context, services, device)
    }),
    vscode.commands.registerCommand('mobileTestBench.openSetupGuide', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/marcomaes/MobileTestBench/blob/main/docs/DEVICE-SETUP.md')),
    ),
  )
  void tree.refresh()
}

/** VS Code started from the Dock has a minimal PATH on macOS; add the usual tool folders. */
function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
  const sep = process.platform === 'win32' ? ';' : ':'
  env.PATH = [...(env.PATH ?? '').split(sep), ...extra].filter((p, i, a) => p && a.indexOf(p) === i).join(sep)
  return env
}

export function deactivate(): void {}
