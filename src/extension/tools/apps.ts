// ported-from: ui/AppsPanel.kt
// ported-from: ui/ResetStateDialog.kt
// ported-from: ui/PermissionsDialog.kt
// Host half of the Apps tab: the mobilecli calls, the Reset state steps and the permission actions. The Swing dialogs became
// forms in the webview half; confirmations are modal VS Code messages.
import * as vscode from 'vscode'
import { Apps, type AppInfo, type ForegroundApp } from '../../core/apps/apps'
import { ResetChoices, ResetPlan, ResetStep, resetStepLabel, type PlannedStep } from '../../core/apps/resetPlan'
import { IosPrivacyActions, iosPrivacyServices, RuntimePermission, type PermissionResult } from '../../core/permissions/permissions'
import type { Device } from '../../core/model'
import type { ToolContext, ToolHost } from './toolHost'

const RESET_KEY = 'mobileTestBench.resetChoices'

const firstLine = (s: string): string => s.split(/\r\n|\n|\r/)[0]
const errorText = (e: unknown): string => Apps.friendlyError(e instanceof Error ? e.message : String(e))

const foregroundDto = (f: ForegroundApp | undefined) => (f ? { id: f.id, name: f.name, activity: f.activity, isHome: f.isHome } : null)

async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action
}

async function foreground(ctx: ToolContext): Promise<ForegroundApp | undefined> {
  try {
    return Apps.parseForeground(await ctx.services.mobilecliData(ctx.device, ['apps', 'foreground']))
  } catch {
    return undefined
  }
}

/** Runs one mobilecli action. Failures carry the friendly message. */
async function call(ctx: ToolContext, args: string[], timeoutMs = 20_000): Promise<void> {
  try {
    await ctx.services.mobilecliCall(ctx.device, args, timeoutMs)
  } catch (e) {
    throw new Error(errorText(e))
  }
}

function permissionDto(p: RuntimePermission) {
  return { name: p.name, granted: p.granted, flags: [...p.flags] }
}

const resultDto = (r: PermissionResult) => ({ text: r.text, ok: r.ok })

/** Runs one step of Reset state (Kotlin `ResetStateDialog.execute`). Returns an optional note for the row; throws with the exact error on failure. */
async function execute(ctx: ToolContext, step: ResetStep, app: AppInfo): Promise<string> {
  const device: Device = ctx.device
  switch (step) {
    case ResetStep.TERMINATE:
      await ctx.services.mobilecliCall(device, Apps.terminateArgs(app.id))
      return ''
    case ResetStep.CLEAR_DATA:
      await ctx.services.mobilecliCall(device, Apps.clearArgs(app.id))
      return ''
    case ResetStep.RELAUNCH:
      await ctx.services.mobilecliCall(device, Apps.launchArgs(device, app.id))
      return 'launched'
    case ResetStep.RESET_PERMISSIONS: {
      if (device.platform === 'ANDROID') {
        const backend = ctx.services.androidPermissions(device)
        const perms = (await backend.read(app.id)).runtime
        if (perms.length === 0) return 'no runtime permissions'
        const failed = (await backend.resetAll(app.id, perms)).find((r) => !r.ok)
        if (failed) throw new Error(failed.text)
        return ''
      }
      const backend = ctx.services.iosPermissions(device)
      if (!backend) throw new Error('needs an iOS simulator on macOS')
      const r = await backend.apply(IosPrivacyActions.RESET, iosPrivacyServices().find((s) => s.simctl === 'all')!, app.id)
      if (!r.ok) throw new Error(r.text)
      return ''
    }
  }
}

const describe = (p: PlannedStep, state: string): string => `${resetStepLabel(p.step)}: ${state}`

async function resetRun(ctx: ToolContext, app: AppInfo, c: Record<string, boolean>, persist: Record<string, boolean>): Promise<void> {
  const choices = new ResetChoices(c.terminate, c.clear, c.permissions, c.relaunch)
  const plan = ResetPlan.plan(ctx.device, choices)
  // Kotlin only stores the clear/permissions choice when its box was enabled; the webview sends the stored value for disabled ones.
  await ctx.extensionContext.globalState.update(RESET_KEY, persist)
  const rows = plan.map((p) => describe(p, p.applies ? 'pending' : (p.note ?? 'skipped')))
  const emit = (i: number, text: string) => ctx.emit('resetStep', { index: i, text })
  rows.forEach((t, i) => emit(i, t))
  let failed = false
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    if (failed) {
      emit(i, describe(p, 'not run'))
      continue
    }
    if (!p.applies) continue
    emit(i, describe(p, 'running...'))
    const started = Date.now()
    try {
      const note = await execute(ctx, p.step, app)
      const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`
      emit(i, describe(p, note.length === 0 ? `done (${secs})` : `${note} (${secs})`))
    } catch (e) {
      failed = true
      emit(i, describe(p, 'FAILED: ' + Apps.friendlyError(ResetPlan.oneLine(e instanceof Error ? e.message : String(e)))))
    }
  }
}

export const appsHost: ToolHost = {
  id: 'apps',
  title: 'Apps',

  async handle(method, params, ctx) {
    const p = (params ?? {}) as Record<string, unknown>
    const device = ctx.device
    switch (method) {
      case 'list': {
        // Loads the app list and the foreground app; Android needs a second source for system apps (a failure leaves every app visible).
        let apps: AppInfo[]
        try {
          apps = Apps.parseList(await ctx.services.mobilecliData(device, ['apps', 'list']))
        } catch (e) {
          throw new Error(errorText(e))
        }
        const fg = await foreground(ctx)
        let userPackages: string[] | null = null
        let userPackagesFailed = false
        if (device.platform === 'ANDROID') {
          try {
            userPackages = [...(await ctx.services.androidPackages(device).userPackages())]
          } catch {
            userPackagesFailed = true
          }
        }
        return { apps, foreground: foregroundDto(fg), userPackages, userPackagesFailed, hideSystem: ctx.settings().hideSystemApps }
      }
      case 'foreground':
        return foregroundDto(await foreground(ctx))
      case 'setHideSystem':
        await ctx.updateSetting('hideSystemApps', Boolean(p.value))
        return
      case 'launch':
        return call(ctx, Apps.launchArgs(device, String(p.id), String(p.locale ?? ''), String(p.activity ?? '')))
      case 'terminate':
        return call(ctx, Apps.terminateArgs(String(p.id)))
      case 'clear':
        if (!(await confirm(`Delete all data of ${p.name} (${p.id})? This cannot be undone. The app is killed, and on Android its runtime permissions are revoked too.`, 'Clear data'))) return { cancelled: true }
        return call(ctx, Apps.clearArgs(String(p.id)))
      case 'uninstall':
        if (!(await confirm(`Uninstall ${p.name} (${p.id}) from the device?`, 'Uninstall'))) return { cancelled: true }
        return call(ctx, Apps.uninstallArgs(String(p.id)))
      case 'install': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Install App', filters: { 'Apps (.apk, .zip, .ipa)': [...Apps.INSTALL_EXTENSIONS] } })
        if (!picked?.[0]) return { cancelled: true }
        const path = picked[0].fsPath
        const problem = Apps.installProblem(device, path)
        if (problem) throw new Error(problem)
        await call(ctx, Apps.installArgs(path), 180_000)
        return { name: path.split(/[\\/]/).pop() }
      }
      case 'resetChoices':
        return ctx.extensionContext.globalState.get(RESET_KEY) ?? { terminate: true, clear: true, permissions: true, relaunch: true }
      case 'resetRun':
        return resetRun(ctx, p.app as AppInfo, p.choices as Record<string, boolean>, p.persist as Record<string, boolean>)

      // ---- Permissions (PermissionsDialog)
      case 'permRead': {
        try {
          const set = await ctx.services.androidPermissions(device).read(String(p.id))
          return { runtime: set.runtime.map(permissionDto), installTimeCount: set.installTimeCount }
        } catch (e) {
          throw new Error(firstLine(e instanceof Error ? e.message : String(e)))
        }
      }
      case 'permGrant':
        return resultDto(await ctx.services.androidPermissions(device).grant(String(p.id), String(p.permission)))
      case 'permRevoke':
        return resultDto(await ctx.services.androidPermissions(device).revoke(String(p.id), String(p.permission)))
      case 'permResetAll': {
        const names = p.permissions as string[]
        if (!(await confirm(`Revoke all ${names.length} runtime permissions of ${p.name} and clear their user-set flags? The app may be terminated.`, 'Reset all'))) return { cancelled: true }
        const perms = names.map((n) => new RuntimePermission(n, false))
        return { results: (await ctx.services.androidPermissions(device).resetAll(String(p.id), perms)).map(resultDto) }
      }
      case 'permIos': {
        const backend = ctx.services.iosPermissions(device)
        if (!backend) return { results: [{ text: 'Not available: needs an iOS simulator on macOS', ok: false }] }
        const action = Object.values(IosPrivacyActions).find((a) => a.name === p.action)
        const service = iosPrivacyServices().find((s) => s.name === p.service)
        if (!action || !service) throw new Error('Unknown action or service')
        if (!(await confirm(`${action.label} ${service.label} for ${p.name}? The app may be terminated if it is running.`, action.label))) return { cancelled: true }
        return { results: [resultDto(await backend.apply(action, service, String(p.id)))] }
      }
      default:
        throw new Error(`Apps: unknown method ${method}`)
    }
  },
}
