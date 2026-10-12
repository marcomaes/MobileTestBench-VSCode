// ported-from: test:core/OrientationTest.kt
import { describe, expect, it } from 'vitest'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import { IosMobilecliSession } from '../../src/core/ios/iosMobilecliSession'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { MobilecliException, MobilecliJson } from '../../src/core/mobilecliJson'
import { makeDevice, size } from '../../src/core/model'
import { FrameOrientation, Orientations } from '../../src/core/orientation'
import { fixture } from '../helpers/fixtures'

describe('OrientationTest', () => {
  it('parsesGetFixture', () => {
    expect(Orientations.parse(fixture('mobilecli-orientation-get.json'))).toBe('landscape')
  })

  it('errorEnvelopeThrowsWithMobilecliText', () => {
    let thrown: unknown
    try {
      Orientations.parse(fixture('mobilecli-orientation-error.json'))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MobilecliException)
    expect((thrown as Error).message).toContain("invalid orientation value 'sideways'")
  })

  it('unknownOrMissingValueThrows', () => {
    for (const bad of ['{"status":"ok","data":{"orientation":"upside"}}', '{"status":"ok"}', 'garbage']) {
      expect(() => Orientations.parse(bad), bad).toThrow(MobilecliException)
    }
  })

  it('commandLines', () => {
    expect(MobilecliJson.commandLine('mobilecli', 'Pixel_9', Orientations.setArgs('landscape'))).toEqual([
      'mobilecli', 'device', 'orientation', 'set', 'landscape', '--device', 'Pixel_9',
    ])
    expect(Orientations.getArgs()).toEqual(['device', 'orientation', 'get'])
    expect(Orientations.other('landscape')).toBe('portrait')
  })

  // The Kotlin test rotates a BufferedImage; the extension turns the frame on a canvas, so the pure decision is what is tested here.
  it('portraitFrameIsRotatedCounterClockwiseForLandscape', () => {
    expect(FrameOrientation.needsUpright(size(2, 4), size(4, 2))).toBe(true)
  })

  it('otherCombinationsAreUntouched', () => {
    expect(FrameOrientation.needsUpright(size(2, 4), size(2, 4))).toBe(false)
    expect(FrameOrientation.needsUpright(size(2, 4), undefined)).toBe(false)
    expect(FrameOrientation.needsUpright(size(4, 2), size(4, 2))).toBe(false)
  })

  /** `device info` answers with the queued screen sizes in order; the last one repeats. An undefined entry is a failed call. */
  class InfoRunner extends CommandRunner {
    private calls = 0
    constructor(private readonly sizes: Array<[number, number] | undefined>) {
      super({})
    }
    override async run(): Promise<CommandResult> {
      const s = this.sizes[Math.min(this.calls++, this.sizes.length - 1)]
      if (!s) return new CommandResult(1, Buffer.alloc(0), 'agent busy')
      const json = `{"status":"ok","data":{"device":{"screenSize":{"width":${s[0]},"height":${s[1]},"scale":3}}}}`
      return new CommandResult(0, Buffer.from(json), '')
    }
  }

  const iosSession = (runner: CommandRunner) =>
    new IosMobilecliSession(makeDevice({ id: 'F2368465', name: 'iPhone 17 Pro', platform: 'IOS', kind: 'SIMULATOR' }), new MobilecliClient('mobilecli', runner))

  it('refreshSizeFollowsTheRotation', async () => {
    const session = iosSession(new InfoRunner([[402, 874], [874, 402]]))
    expect(session.logicalSize()).toBeUndefined()
    await session.refreshSize()
    expect(session.logicalSize()).toEqual(size(402, 874))
    await session.refreshSize() // after rotating to landscape
    expect(session.logicalSize()).toEqual(size(874, 402))
  })

  it('failedRefreshKeepsTheLastKnownSize', async () => {
    const session = iosSession(new InfoRunner([[402, 874], undefined]))
    await session.refreshSize()
    await session.refreshSize()
    expect(session.logicalSize()).toEqual(size(402, 874))
  })
})
