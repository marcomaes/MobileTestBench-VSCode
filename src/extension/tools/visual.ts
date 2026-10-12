// ported-from: ui/VisualPanel.kt
// Host half of the Visual tab: baselines on disk (core/visual), the current frame from the viewer, the comparison and the region overlay on
// the mirror. Everything runs inside the extension; no device command is needed except the foreground app for the default name.
import * as path from 'node:path'
import * as vscode from 'vscode'
import { decodeFrame, decodeImage, encodePng, type PixelReader } from '../../core/image/pixels'
import { toFrame } from '../../core/image/dimensions'
import { rect, type Rect, type Size } from '../../core/model'
import { BaselineNames, BaselineStore, type Baseline } from '../../core/visual/baselines'
import { DiffOptions, ImageDiff } from '../../core/visual/imageDiff'
import type { ToolContext, ToolHost } from './toolHost'

interface State {
  /** Logical coordinates of the regions of the last comparison; empty when there is none. */
  lastRegions: Rect[]
  visible: boolean
  store: BaselineStore | undefined
  storeRoot: string | undefined
}

// One ToolHost serves every open viewer, so the state is kept per device object (the viewer hands out a fresh ToolContext per call).
const states = new WeakMap<object, State>()

function stateOf(ctx: ToolContext): State {
  let st = states.get(ctx.device)
  if (!st) {
    st = { lastRegions: [], visible: false, store: undefined, storeRoot: undefined }
    states.set(ctx.device, st)
  }
  return st
}

/** `<workspace>/.mobiletestbench/baselines` like the plugin's project folder, else the extension's global storage. */
function storeOf(ctx: ToolContext, st: State): BaselineStore {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const root = folder ? path.join(folder, '.mobiletestbench', 'baselines') : path.join(ctx.extensionContext.globalStorageUri.fsPath, 'baselines')
  if (!st.store || st.storeRoot !== root) {
    st.store = new BaselineStore(root)
    st.storeRoot = root
  }
  return st.store
}

interface BaselineDto {
  name: string
  savedAt: number
  ignore: Rect[]
  frame: Size
  logical: Size
}

const dto = (b: Baseline): BaselineDto => ({ name: b.name, savedAt: b.info.savedAt, ignore: b.info.ignoreRects, frame: b.info.frameSize, logical: b.info.logicalSize })

const confirm = async (message: string, action: string): Promise<boolean> => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action

interface Outcome {
  message: string
  bad: boolean
  base: string | undefined
  current: string | undefined
  diff: string | undefined
  regions: Rect[]
}

const dataUrl = (mime: string, data: Buffer): string => `data:${mime};base64,${data.toString('base64')}`

function setRegions(ctx: ToolContext, st: State, regions: Rect[]): void {
  st.lastRegions = regions
  ctx.highlight(st.visible ? regions : [])
}

async function compare(ctx: ToolContext, store: BaselineStore, b: Baseline, options: DiffOptions): Promise<Outcome> {
  const frameBytes = ctx.currentFrame()
  if (!frameBytes) throw new Error('There is no frame to compare yet')
  const frame = toFrame(frameBytes.data)
  if (!frame) throw new Error('The current frame is not a PNG or JPEG')
  const logical = ctx.session()?.logicalSize()
  const baseBytes = await store.load(b)
  const base = decodeImage(baseBytes)
  const current = decodeFrame(frame)
  if (base.width !== current.width || base.height !== current.height) {
    return {
      message:
        `Not compared: the baseline is ${base.width}x${base.height} but the current frame is ${current.width}x${current.height} ` +
        '(rotated, another device or another scale). Save a new baseline for this screen size.',
      bad: true,
      base: dataUrl('image/png', baseBytes),
      current: dataUrl(frame.mime, frame.data),
      diff: undefined,
      regions: [],
    }
  }
  const frameSize: Size = { width: current.width, height: current.height }
  const loggedSize = b.info.logicalSize
  const baseLogical = loggedSize.width > 0 && loggedSize.height > 0 ? loggedSize : (logical ?? frameSize)
  const ignore = b.info.ignoreRects.map((r) => ImageDiff.scale(r, baseLogical, frameSize))
  const result = ImageDiff.compare(base, current, options, ignore)!
  const target = logical ?? frameSize
  return {
    message: result.verdict(),
    bad: false,
    base: dataUrl('image/png', baseBytes),
    current: dataUrl(frame.mime, frame.data),
    diff: dataUrl('image/png', encodePng(ImageDiff.render(current, result))),
    regions: result.regions.map((r) => ImageDiff.scale(r, frameSize, target)),
  }
}

/** The current frame as pixels plus the logical size; throws the plugin's message when there is none yet. */
function currentPixels(ctx: ToolContext): { pixels: PixelReader; logical: Size | undefined } {
  const raw = ctx.currentFrame()
  const frame = raw && toFrame(raw.data)
  if (!frame) throw new Error('There is no frame to save yet')
  return { pixels: decodeFrame(frame), logical: ctx.session()?.logicalSize() }
}

async function foregroundApp(ctx: ToolContext): Promise<string | undefined> {
  try {
    const data = await ctx.services.mobilecliData(ctx.device, ['apps', 'foreground'])
    const id = data && typeof data === 'object' ? (data as Record<string, unknown>).packageName : undefined
    return typeof id === 'string' && id.trim() ? id : undefined
  } catch {
    return undefined
  }
}

async function find(store: BaselineStore, ctx: ToolContext, name: unknown): Promise<Baseline> {
  const b = (await store.list(ctx.device.name)).find((x) => x.name === name)
  if (!b) throw new Error(`The baseline "${String(name)}" no longer exists; refresh the list`)
  return b
}

export const visualHost: ToolHost = {
  id: 'visual',
  title: 'Visual',

  async handle(method, params, ctx) {
    const st = stateOf(ctx)
    const store = storeOf(ctx, st)
    const p = (params ?? {}) as Record<string, unknown>
    const deviceName = ctx.device.name
    switch (method) {
      case 'info':
        return { tolerance: Math.min(64, Math.max(0, ctx.settings().visualTolerance)), defaultName: BaselineNames.defaultName(await foregroundApp(ctx)), regions: st.lastRegions }

      case 'list':
        return (await store.list(deviceName)).map(dto)

      case 'setTolerance':
        await ctx.updateSetting('visualTolerance', Math.min(64, Math.max(0, Math.trunc(Number(p.value)))))
        return undefined

      case 'save': {
        const name = String(p.name ?? '').trim() || BaselineNames.defaultName(await foregroundApp(ctx))
        const { pixels, logical } = currentPixels(ctx)
        const existing = (await store.list(deviceName)).some((b) => b.name === BaselineNames.sanitize(name))
        if (existing && !(await confirm(`A baseline named "${name}" already exists. Replace its image with the current frame?`, 'Replace'))) return { cancelled: true }
        const saved = await store.save(deviceName, name, pixels, logical)
        return { name: saved.name, message: `Saved baseline "${saved.name}" (${pixels.width}x${pixels.height}) in ${path.dirname(saved.png)}` }
      }

      case 'update': {
        const b = await find(store, ctx, p.name)
        const { pixels, logical } = currentPixels(ctx)
        if (!(await confirm(`Replace the image of "${b.name}" with the current frame? Its ignore areas are kept.`, 'Replace'))) return { cancelled: true }
        const saved = await store.replaceImage(b, pixels, logical)
        setRegions(ctx, st, [])
        return { name: saved.name, message: `Updated baseline "${saved.name}" (${pixels.width}x${pixels.height})` }
      }

      case 'rename': {
        const b = await find(store, ctx, p.name)
        const existing = (await store.list(deviceName)).map((x) => x.name)
        const raw = await vscode.window.showInputBox({
          title: 'Rename Baseline',
          prompt: `New name for "${b.name}":`,
          value: b.name,
          validateInput: (v) => BaselineNames.renameError(v, b.name, existing),
        })
        if (raw === undefined) return { cancelled: true }
        const renamed = await store.rename(b, raw)
        return { name: renamed.name, message: `Renamed "${b.name}" to "${renamed.name}"` }
      }

      case 'delete': {
        const b = await find(store, ctx, p.name)
        await store.delete(b)
        setRegions(ctx, st, [])
        return { message: `Deleted "${b.name}"` }
      }

      case 'addIgnore': {
        const b = await find(store, ctx, p.name)
        const r = BaselineNames.parseRect(String(p.text ?? ''))
        if (!r) throw new Error('Ignore area: enter x, y, width and height as whole numbers (width and height above 0)')
        return dto(await store.updateIgnore(b, [...b.info.ignoreRects, rect(r.x, r.y, r.width, r.height)]))
      }

      case 'removeIgnore': {
        const b = await find(store, ctx, p.name)
        const index = Number(p.index)
        return dto(await store.updateIgnore(b, b.info.ignoreRects.filter((_, i) => i !== index)))
      }

      case 'compare': {
        const b = await find(store, ctx, p.name)
        const outcome = await compare(ctx, store, b, DiffOptions({ tolerance: Math.trunc(Number(p.tolerance ?? ctx.settings().visualTolerance)) }))
        setRegions(ctx, st, outcome.regions)
        return outcome
      }

      case 'clearResult':
        setRegions(ctx, st, [])
        return undefined

      default:
        throw new Error(`Visual: unknown method ${method}`)
    }
  },

  shown(ctx) {
    const st = stateOf(ctx)
    st.visible = true
    ctx.highlight(st.lastRegions)
  },

  hidden(ctx) {
    const st = stateOf(ctx)
    st.visible = false
    ctx.highlight([])
  },

  dispose(ctx) {
    const st = states.get(ctx.device)
    if (st) {
      st.visible = false
      st.lastRegions = []
    }
    ctx.highlight([])
  },
}
