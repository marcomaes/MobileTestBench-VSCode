// ported-from: ui/DeviceToolWindowFactory.kt
import * as vscode from 'vscode'
import { DeviceServices, createGrpcLink } from '../deviceServices'
import type { Device } from '../core/model'
import { DeviceTree } from './deviceTree'
import { DeviceViewer } from './deviceViewer'
import { readSettings } from './settings'
import { PowerActions, type PowerAction } from '../core/power/devicePower'
import { runPowerAndWait } from './devicePower'
import { EditorInsert } from './editorInsert'
import { EditorLocatorText } from './editorLocatorText'
import { ShowLocatorResult } from '../core/inspector/showLocator'

export function activate(context: vscode.ExtensionContext): void {
  const services = new DeviceServices(readSettings, shellEnvironment(), createGrpcLink(shellEnvironment()))
  const tree = new DeviceTree(services)
  EditorInsert.track(context)

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
    vscode.commands.registerCommand('mobileTestBench.showLocator', () => showLocator(context)),
    vscode.commands.registerCommand('mobileTestBench.openSetupGuide', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/marcomaes/MobileTestBench/blob/main/docs/DEVICE-SETUP.md')),
    ),
  )
  // Device Power from the Devices view (the viewer toolbar has the same actions): boot an offline device, shut down or reboot a running one.
  const power = (action: PowerAction) => async (target?: Device | { device: Device }) => {
    const device = target && 'device' in target ? target.device : target
    if (!device) return void vscode.window.showInformationMessage('Select a device in the Devices view first.')
    if (!PowerActions.isAvailableFor(action, device)) return void vscode.window.showInformationMessage(`${PowerActions.label(action)} is not available for ${device.name} in its current state.`)
    if (PowerActions.needsConfirmation(action)) {
      const answer = await vscode.window.showWarningMessage(PowerActions.confirmText(action, device), { modal: true }, 'Yes')
      if (answer !== 'Yes') return
    }
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: PowerActions.progressText(action, device) }, () =>
      runPowerAndWait(services, action, device, () => false),
    )
    await tree.refresh()
    if (outcome.error) void vscode.window.showErrorMessage(`${PowerActions.label(action)} of ${device.name} failed: ${outcome.error}`)
    else if (outcome.timedOut) void vscode.window.showWarningMessage(`${device.name} did not appear in time. Refresh the Devices view when it has started.`)
    else if (outcome.up) {
      const up = outcome.up
      void vscode.window.showInformationMessage(`${device.name} is up. Open it?`, 'Open').then((pick) => (pick === 'Open' ? DeviceViewer.show(context, services, up) : undefined))
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('mobileTestBench.bootDevice', power('BOOT')),
    vscode.commands.registerCommand('mobileTestBench.shutdownDevice', power('SHUTDOWN')),
    vscode.commands.registerCommand('mobileTestBench.rebootDevice', power('REBOOT')),
  )
  void tree.refresh()
  // Setting reconnectToLastDevice: open the device of the previous session of this workspace.
  void DeviceViewer.restoreLast(context, services).catch(() => undefined)
}

/**
 * Editor command "Show Locator on Device" (the Kotlin ShowLocatorAction): tries the locator of the selection or caret line on the device
 * of the viewer that was focused last and shows the result. Without a viewer it offers to open a device.
 */
async function showLocator(_context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return
  const doc = editor.document
  const selected = editor.selection.isEmpty ? undefined : doc.getText(editor.selection)
  const text = EditorLocatorText.of(doc.getText(), doc.offsetAt(editor.selection.active), selected)
  const viewer = DeviceViewer.active
  if (!viewer) {
    const message = ShowLocatorResult.NoDevice.message().replace(/^./, (c) => c.toUpperCase())
    const pick = await vscode.window.showWarningMessage(message, 'Open Device')
    if (pick === 'Open Device') void vscode.commands.executeCommand('mobileTestBench.openDevice')
    return
  }
  const result = await viewer.showLocator(text)
  const line = result.message().replace(/^./, (c) => c.toUpperCase())
  if (result.isSuccess) void vscode.window.showInformationMessage(line)
  else void vscode.window.showWarningMessage(line)
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
