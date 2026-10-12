// ported-from: ui/DeviceViewerPanel.kt (region screenshot)
// No vscode import, so it is unit tested. The Kotlin frames are already upright; here the webview turns them, so a saved
// screenshot must be turned too (see FrameOrientation.upright).
import type { Frame } from '../core/image/dimensions'
import { PixelImage, decodeFrame, encodePng } from '../core/image/pixels'
import type { Rect, Size } from '../core/model'
import { ScreenshotAnnotator } from '../core/screenshotAnnotator'

/** The picture turned 90 degrees counter-clockwise (what a portrait framebuffer with landscape content needs). */
export function rotateCounterClockwise(img: PixelImage): PixelImage {
  const out = new PixelImage(img.height, img.width)
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.setRgb(x, y, img.getRgb(img.width - 1 - y, x))
  return out
}

/** PNG bytes of [frame]: turned upright when asked, with [outline] (logical bounds) drawn on it. */
export function screenshotPng(frame: Frame, upright: boolean, logical: Size | undefined, outline?: Rect): Buffer {
  if (!upright && !outline && frame.mime === 'image/png') return frame.data
  let image = decodeFrame(frame)
  if (upright) image = rotateCounterClockwise(image)
  if (outline && logical) image = ScreenshotAnnotator.outline(image, logical, outline)
  return encodePng(image)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `Pixel-9-20260101-120000.png`: the device name with unsafe characters replaced, then the local time. */
export function fileStamp(deviceName: string | undefined, extension: string, date: Date = new Date()): string {
  const name = deviceName ? deviceName.replace(/[^A-Za-z0-9._-]+/g, '-') : 'device'
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${name}-${stamp}.${extension}`
}
