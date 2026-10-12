// ported-from: test:core/CoordinatesTest.kt
import { describe, expect, it } from 'vitest'
import { CoordinateMapper, CoordinateText, ElementInfo, GridSteps } from '../../src/core/coords/coordinates'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect, size } from '../../src/core/model'
import { ScreenGeometry } from '../../src/core/screenGeometry'

// 100x200 panel without padding, frame is 2x the logical size (retina).
const geometry = new ScreenGeometry(size(100, 200), size(200, 400), 0)
const logical = size(100, 200)
const frame = size(200, 400)

describe('CoordinatesTest', () => {
  it('mapsPanelToLogicalFrameAndPercent', () => {
    const p = CoordinateMapper.map(geometry, 50, 100, logical, frame)!
    expect(p.x).toBe(50)
    expect(p.y).toBe(100)
    expect(p.frameX).toBe(100)
    expect(p.frameY).toBe(200)
    expect(Math.abs(p.percentX - 50.5)).toBeLessThanOrEqual(0.001)
    expect(Math.abs(p.percentY - 50.25)).toBeLessThanOrEqual(0.001)
    expect(p.frameDiffers).toBe(true)
  })

  it('outsideTheImageIsNull', () => {
    const g = new ScreenGeometry(size(300, 200), size(100, 200), 0)
    expect(CoordinateMapper.map(g, 5, 100, size(100, 200), size(100, 200))).toBeUndefined()
    expect(CoordinateMapper.map(g, 150, 100, size(100, 200), size(100, 200))).toBeDefined()
  })

  it('sameSizeFrameDoesNotDiffer', () => {
    const g = new ScreenGeometry(size(100, 200), size(100, 200), 0)
    const p = CoordinateMapper.map(g, 10, 20, size(100, 200), size(100, 200))!
    expect(p.frameDiffers).toBe(false)
  })

  it('logicalPointRoundTripsThroughThePanel', () => {
    const [px, py] = geometry.logicalToPanelPoint(30, 40, logical)
    const back = geometry.panelToLogical(px, py, logical)
    expect(back).toEqual([30, 40])
  })

  it('letterboxedGeometryKeepsPercentRelativeToTheImage', () => {
    const g = new ScreenGeometry(size(400, 200), size(100, 200), 0) // image 100 wide centred at x=150
    const corner = CoordinateMapper.map(g, 150, 0, size(100, 200), size(100, 200))!
    expect(corner.x).toBe(0)
    expect(corner.y).toBe(0)
    const middle = CoordinateMapper.map(g, 200, 100, size(100, 200), size(100, 200))!
    expect(middle.x).toBe(50)
    expect(middle.y).toBe(100)
    expect(Math.abs(middle.percentX - 50.0)).toBeLessThanOrEqual(1.0)
    expect(Math.abs(middle.percentY - 50.0)).toBeLessThanOrEqual(1.0)
    const far = CoordinateMapper.map(g, 249, 199, size(100, 200), size(100, 200))!
    expect(far.x).toBe(99)
    expect(far.y).toBe(199)
    expect(Math.abs(far.percentX - 99.0)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(far.percentY - 99.5)).toBeLessThanOrEqual(1.5)
    expect(CoordinateMapper.map(g, 100, 100, size(100, 200), size(100, 200))).toBeUndefined() // left black bar
    expect(CoordinateMapper.map(g, 300, 100, size(100, 200), size(100, 200))).toBeUndefined() // right black bar
  })

  it('textFormats', () => {
    const p = CoordinateMapper.map(geometry, 50, 100, logical, frame)!
    expect(CoordinateText.xy(p)).toBe('50, 100')
    expect(CoordinateText.percent(p)).toBe('50.5%, 50.3%')
    const e = new ElementInfo('Button', rect(10, 20, 200, 44))
    expect(CoordinateText.size(e)).toBe('200 x 44')
    expect(CoordinateText.bounds(e)).toBe('10, 20, 200, 44')
  })

  it('infoLineParts', () => {
    const p = CoordinateMapper.map(geometry, 50, 100, logical, frame)!
    const line = CoordinateText.infoLine(p, 'IOS', new ElementInfo('Button', rect(0, 0, 10, 20)), true)
    expect(line.startsWith('x 50, y 100 pt'), line).toBe(true)
    expect(line.includes('frame 100, 200 px'), line).toBe(true)
    expect(line.includes('Button  10 x 20'), line).toBe(true)
    const android = CoordinateText.infoLine(CoordinateMapper.map(new ScreenGeometry(size(100, 200), size(100, 200), 0), 5, 6, logical, logical)!, 'ANDROID', undefined, false)
    expect(android.includes('px') && !android.includes('frame') && android.includes('open the inspector'), android).toBe(true)
    expect(CoordinateText.infoLine(undefined, undefined, undefined, false).startsWith('Move the mouse')).toBe(true)
  })

  it('elementInfoFromNode', () => {
    const node = new UiNode('ANDROID', 'android.widget.Button', { text: 'Go' }, rect(1, 2, 3, 4))
    const info = ElementInfo.of(node)!
    expect(info.bounds).toEqual(rect(1, 2, 3, 4))
    expect(info.description.startsWith('Button')).toBe(true)
    expect(ElementInfo.of(new UiNode('ANDROID', 'x', {}, undefined))).toBeUndefined()
    expect(ElementInfo.of(undefined)).toBeUndefined()
  })

  it('gridStepKeepsAboutEightToTwelveLines', () => {
    expect(GridSteps.choose(size(393, 852))).toBe(100) // iPhone points
    expect(GridSteps.choose(size(1080, 2400))).toBe(200) // Pixel pixels
    expect(GridSteps.choose(size(1600, 2560))).toBe(200)
    for (const s of [size(393, 852), size(1080, 2400), size(1440, 3120), size(320, 480), size(2560, 1600)]) {
      const n = GridSteps.lines(Math.max(s.width, s.height), GridSteps.choose(s)).length
      expect(n >= 5 && n <= GridSteps.MAX_LINES, `${JSON.stringify(s)} has ${n} lines`).toBe(true)
    }
  })

  it('gridLinesAreInsideTheExtent', () => {
    expect(GridSteps.lines(300, 100)).toEqual([100, 200])
    expect(GridSteps.lines(301, 100).slice(0, 2)).toEqual([100, 200])
    expect(GridSteps.lines(100, 100)).toEqual([])
    expect(GridSteps.lines(0, 50)).toEqual([])
  })
})
