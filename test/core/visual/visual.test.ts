// ported-from: test:core/visual/VisualTest.kt
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PixelImage, decodeImage } from '../../../src/core/image/pixels'
import { rect, type Rect } from '../../../src/core/model'
import { BaselineNames, BaselineStore } from '../../../src/core/visual/baselines'
import { DiffOptions, ImageDiff } from '../../../src/core/visual/imageDiff'

const image = (w: number, h: number, rgb = 0xffffff) => new PixelImage(w, h, 0xff000000 | rgb)
const fill = (img: PixelImage, r: Rect, rgb: number) => {
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) img.setRgb(x, y, 0xff000000 | rgb)
}
const compare = (...a: Parameters<typeof ImageDiff.compare>) => ImageDiff.compare(...a)!

describe('VisualTest', () => {
  it('identicalImagesMatch', () => {
    const r = compare(image(40, 30), image(40, 30))
    expect(r.matches).toBe(true)
    expect(r.changedPixels).toBe(0)
    expect(r.comparedPixels).toBe(1200)
    expect(r.verdict()).toBe('Match: no differences')
  })

  it('differentSizesCannotBeCompared', () => {
    expect(ImageDiff.compare(image(40, 30), image(30, 40))).toBeUndefined()
  })

  it('solidBlockIsOneRegionWithPercent', () => {
    const b = image(100, 100)
    const c = image(100, 100)
    fill(c, rect(10, 20, 20, 10), 0x000000)
    const r = compare(b, c)
    expect(r.regions).toEqual([rect(10, 20, 20, 10)])
    expect(r.changedPixels).toBe(200)
    expect(r.percent).toBeCloseTo(2.0, 4)
    expect(r.verdict()).toBe('1 region, 2.00% of the pixels changed')
  })

  it('toleranceIsPerChannel', () => {
    const b = image(10, 10, 0x808080)
    const c = image(10, 10, 0x808080)
    fill(c, rect(0, 0, 10, 10), 0x888080) // red +8
    expect(compare(b, c, DiffOptions({ tolerance: 8 })).matches).toBe(true)
    expect(compare(b, c, DiffOptions({ tolerance: 7 })).matches).toBe(false)
    expect(compare(b, c, DiffOptions({ tolerance: 0 })).matches).toBe(false)
  })

  it('nearbyChangesMergeAndFarOnesStaySeparate', () => {
    const b = image(200, 100)
    const c = image(200, 100)
    fill(c, rect(10, 10, 5, 5), 0)
    fill(c, rect(20, 10, 5, 5), 0) // 5px gap: merged
    fill(c, rect(150, 70, 6, 6), 0) // far away
    expect(compare(b, c, DiffOptions({ mergeGap: 8 })).regions).toEqual([rect(10, 10, 15, 5), rect(150, 70, 6, 6)])
  })

  it('mergingFollowsTheBlockGridNotTheExactDistance', () => {
    const regions = (x1: number, x2: number) => {
      const c = image(64, 8)
      fill(c, rect(x1, 0, 1, 4), 0)
      fill(c, rect(x2, 0, 1, 4), 0)
      return compare(image(64, 8), c, DiffOptions({ mergeGap: 8 })).regions.length
    }
    expect(regions(0, 15)).toBe(1) // 15 px apart, neighbouring blocks 0 and 1: merged
    expect(regions(7, 16)).toBe(2) // 9 px apart but blocks 0 and 2: separate
    expect(regions(0, 16)).toBe(2) // blocks 0 and 2
  })

  it('tinyRegionsAreIgnored', () => {
    const b = image(60, 60)
    const c = image(60, 60)
    c.setRgb(5, 5, 0xff000000)
    c.setRgb(6, 5, 0xff000000)
    fill(c, rect(30, 30, 10, 10), 0)
    const r = compare(b, c, DiffOptions({ minRegionPixels: 4 }))
    expect(r.regions).toEqual([rect(30, 30, 10, 10)])
    expect(r.changedPixels).toBe(100)
    expect(r.mask[5 * 60 + 5]).toBe(false)
  })

  it('oneStepEdgeShiftIsForgivenOnlyWithAntiAliasing', () => {
    // A vertical black bar whose edge moves by one pixel.
    const b = image(40, 20)
    const c = image(40, 20)
    fill(b, rect(0, 0, 20, 20), 0)
    fill(c, rect(0, 0, 21, 20), 0)
    expect(compare(b, c, DiffOptions({ antiAliasing: true, minRegionPixels: 1 })).matches).toBe(true)
    expect(compare(b, c, DiffOptions({ antiAliasing: false, minRegionPixels: 1 })).matches).toBe(false)
  })

  it('twoPixelShiftIsStillAChange', () => {
    const b = image(40, 20)
    const c = image(40, 20)
    fill(b, rect(0, 0, 20, 20), 0)
    fill(c, rect(0, 0, 23, 20), 0)
    expect(compare(b, c, DiffOptions({ minRegionPixels: 1 })).matches).toBe(false)
  })

  it('solidColourChangeIsNotForgiven', () => {
    const r = compare(image(20, 20, 0xffffff), image(20, 20, 0x000000))
    expect(r.changedPixels).toBe(400)
    expect(r.percent).toBeCloseTo(100.0, 4)
  })

  it('ignoreRegionsAreSkippedAndNotCounted', () => {
    const b = image(100, 50)
    const c = image(100, 50)
    fill(c, rect(0, 0, 100, 10), 0) // "status bar"
    fill(c, rect(40, 30, 10, 10), 0)
    const r = compare(b, c, DiffOptions(), [rect(0, 0, 100, 10)])
    expect(r.regions).toEqual([rect(40, 30, 10, 10)])
    expect(r.comparedPixels).toBe(4000)
    expect(r.percent).toBeCloseTo(2.5, 4)
    expect(compare(b, c, DiffOptions(), [rect(0, 0, 100, 10), rect(40, 30, 10, 10)]).matches).toBe(true)
  })

  it('ignoreRectOutsideTheImageIsHarmless', () => {
    const r = compare(image(10, 10), image(10, 10), DiffOptions(), [rect(-5, -5, 100, 100), rect(50, 50, 5, 5)])
    expect(r.matches).toBe(true)
    expect(r.comparedPixels).toBe(0)
    expect(r.percent).toBe(0)
  })

  it('renderPaintsChangedPixelsRedOverFadedCurrent', () => {
    const b = image(10, 10)
    const c = image(10, 10, 0x000000)
    const b2 = image(10, 10)
    const cur = image(10, 10)
    fill(cur, rect(2, 2, 4, 4), 0)
    const r = compare(b2, cur)
    const out = ImageDiff.render(cur, r)
    expect(out.getRgb(3, 3)).toBe(0xffff0000 | 0)
    expect(out.getRgb(8, 8)).toBe(0xffffffff | 0)
    // Unchanged dark pixels would be faded, not black.
    const faded = ImageDiff.render(c, compare(b, b))
    expect(faded.getRgb(0, 0) & 0xff).toBeGreaterThan(0x60)
  })

  it('scaleMapsRectsBetweenSpaces', () => {
    expect(ImageDiff.scale(rect(20, 40, 60, 80), { width: 200, height: 400 }, { width: 100, height: 200 })).toEqual(rect(10, 20, 30, 40))
    expect(ImageDiff.scale(rect(1, 2, 3, 4), { width: 10, height: 10 }, { width: 10, height: 10 })).toEqual(rect(1, 2, 3, 4))
    expect(ImageDiff.scale(rect(1, 2, 3, 4), { width: 0, height: 0 }, { width: 10, height: 10 })).toEqual(rect(1, 2, 3, 4))
    expect(ImageDiff.scale(rect(0, 0, 1, 1), { width: 1000, height: 1000 }, { width: 10, height: 10 }).width).toBe(1)
  })

  // region names
  it('sanitizeKeepsSafeCharactersOnly', () => {
    expect(BaselineNames.sanitize('Pixel_9')).toBe('Pixel_9')
    expect(BaselineNames.sanitize('a/b\\c')).toBe('a_b_c')
    expect(BaselineNames.sanitize('  iPhone   17 Pro ')).toBe('iPhone 17 Pro')
    expect(BaselineNames.sanitize('   ')).toBe('baseline')
    expect(BaselineNames.sanitize('...')).toBe('baseline')
    expect(BaselineNames.sanitize('../x')).not.toContain('/')
  })

  it('defaultNameUsesAppAndDate', () => {
    const d = new Date(0)
    expect(BaselineNames.defaultName(undefined, d).startsWith('screen-19')).toBe(true)
    expect(BaselineNames.defaultName('com.example.app', d).startsWith('com.example.app-19')).toBe(true)
  })

  it('parseRect', () => {
    expect(BaselineNames.parseRect('0, 0, 100, 40')).toEqual(rect(0, 0, 100, 40))
    expect(BaselineNames.parseRect('1 2 3 4')).toEqual(rect(1, 2, 3, 4))
    expect(BaselineNames.parseRect('1,2,3')).toBeUndefined()
    expect(BaselineNames.parseRect('1,2,0,4')).toBeUndefined()
    expect(BaselineNames.parseRect('-1,2,3,4')).toBeUndefined()
    expect(BaselineNames.parseRect('a,b,c,d')).toBeUndefined()
  })

  // region store
  const tempStore = (): [BaselineStore, string] => {
    const dir = mkdtempSync(join(tmpdir(), 'baselines-'))
    return [new BaselineStore(dir), dir]
  }

  it('saveListLoadDelete', async () => {
    const [store, dir] = tempStore()
    const img = image(30, 20, 0x336699)
    const saved = await store.save('Pixel 9', 'home', img, { width: 15, height: 10 }, 1234)
    expect(saved.png).toBe(join(dir, 'Pixel 9/home.png'))
    expect(existsSync(join(dir, 'Pixel 9/home.json'))).toBe(true)
    const list = await store.list('Pixel 9')
    expect(list.map((b) => b.name)).toEqual(['home'])
    expect(list[0].info.logicalSize).toEqual({ width: 15, height: 10 })
    expect(list[0].info.frameSize).toEqual({ width: 30, height: 20 })
    expect(list[0].info.savedAt).toBe(1234)
    expect(decodeImage(await store.load(list[0])).getRgb(5, 5) & 0xffffff).toBe(0x336699)
    expect(await store.list('other')).toEqual([])
    await store.delete(list[0])
    expect(await store.list('Pixel 9')).toEqual([])
    expect(existsSync(join(dir, 'Pixel 9/home.json'))).toBe(false)
  })

  it('ignoreRegionsPersistAndSurviveResave', async () => {
    const [store] = tempStore()
    const saved = await store.save('d', 'n', image(10, 10), undefined)
    expect(saved.info.logicalSize).toEqual({ width: 10, height: 10 })
    await store.updateIgnore(saved, [rect(0, 0, 10, 2), rect(1, 2, 3, 4)])
    expect((await store.list('d'))[0].info.ignoreRects).toEqual([rect(0, 0, 10, 2), rect(1, 2, 3, 4)])
    await store.save('d', 'n', image(10, 10, 0), undefined)
    expect((await store.list('d'))[0].info.ignoreRects).toHaveLength(2)
  })

  it('missingOrBrokenSidecarStillListsTheBaseline', async () => {
    const [store, dir] = tempStore()
    await store.save('d', 'n', image(4, 4), undefined)
    writeFileSync(join(dir, 'd/n.json'), '{ not json')
    const list = await store.list('d')
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('n')
    expect(list[0].info.logicalWidth).toBe(0)
    rmSync(join(dir, 'd/n.json'))
    expect(await store.list('d')).toHaveLength(1)
  })

  it('namesWithPathCharactersStayInsideTheDeviceFolder', async () => {
    const [store, dir] = tempStore()
    const saved = await store.save('d', '../../evil', image(4, 4), undefined)
    expect(saved.png.startsWith(join(dir, 'd') + '/')).toBe(true)
    expect(saved.png.slice(join(dir, 'd').length + 1)).not.toContain('/')
  })

  it('renameErrorRules', () => {
    const existing = ['home', 'Login']
    expect(BaselineNames.renameError('  ', 'home', existing)).toBe('Enter a name')
    expect(BaselineNames.renameError('home', 'home', existing)).toBe('That is already the name')
    expect(BaselineNames.renameError('login', 'home', existing)).toContain('already exists')
    expect(BaselineNames.renameError('a/b', 'home', ['home', 'a_b'])).toContain('a_b')
    expect(BaselineNames.renameError('settings', 'home', existing)).toBeUndefined()
    expect(BaselineNames.renameError('Home', 'home', existing)).toBeUndefined()
  })

  it('defaultNameFromAppIsSanitized', () => {
    expect(BaselineNames.defaultName('com/example app', new Date(0)).startsWith('com_example app-19')).toBe(true)
  })

  it('renameMovesImageAndSidecarAndKeepsIgnore', async () => {
    const [store, dir] = tempStore()
    const saved = await store.save('Pixel 7', 'old', image(8, 8), { width: 4, height: 4 })
    const withIgnore = await store.updateIgnore(saved, [rect(1, 1, 2, 2)])
    const renamed = await store.rename(withIgnore, 'new name')
    expect(renamed.name).toBe('new name')
    expect(existsSync(saved.png)).toBe(false)
    expect(existsSync(join(dir, 'Pixel 7/old.json'))).toBe(false)
    const listed = await store.list('Pixel 7')
    expect(listed.map((b) => b.name)).toEqual(['new name'])
    expect(listed[0].info.ignoreRects).toEqual([rect(1, 1, 2, 2)])
  })

  it('replaceImageKeepsIgnoreAndFileName', async () => {
    const [store] = tempStore()
    const saved = await store.save('Pixel 7', 'a', image(8, 8), { width: 4, height: 4 })
    const withIgnore = await store.updateIgnore(saved, [rect(1, 1, 2, 2)])
    const replaced = await store.replaceImage(withIgnore, image(16, 16), { width: 8, height: 8 })
    expect(replaced.png).toBe(saved.png)
    expect(decodeImage(await store.load(replaced)).width).toBe(16)
    expect((await store.list('Pixel 7'))[0].info.ignoreRects).toEqual([rect(1, 1, 2, 2)])
  })

  it('renameOntoExistingNameFailsAndChangesNothing', async () => {
    const [store] = tempStore()
    const a = await store.save('Pixel 7', 'a', image(8, 8), undefined)
    await store.save('Pixel 7', 'b', image(8, 8), undefined)
    await expect(store.rename(a, 'b')).rejects.toThrow(/already exists/)
    expect((await store.list('Pixel 7')).map((b) => b.name)).toEqual(['a', 'b'])
  })
})
