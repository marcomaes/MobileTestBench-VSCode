// ported-from: test:core/LocationOverrideTest.kt
import { describe, expect, it } from 'vitest'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { LocationOverride, place } from '../../src/core/location/locationOverride'
import { MobilecliJson } from '../../src/core/mobilecliJson'
import { fixture } from '../helpers/fixtures'

class FakeRunner extends CommandRunner {
  last: string[] | undefined
  constructor(
    private readonly exit: number,
    private readonly out: string,
    private readonly err = '',
  ) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.last = command
    return new CommandResult(this.exit, Buffer.from(this.out), this.err)
  }
}

describe('LocationOverrideTest', () => {
  it('pasted pairs are split', () => {
    expect(LocationOverride.parsePair('52.3676, 4.9041')).toEqual(['52.3676', '4.9041'])
    expect(LocationOverride.parsePair(' -33.8688,151.2093 ')).toEqual(['-33.8688', '151.2093'])
    expect(LocationOverride.parsePair('1; 2')).toEqual(['1', '2'])
    expect(LocationOverride.parsePair('1.5 -2.5')).toEqual(['1.5', '-2.5'])
    expect(LocationOverride.parsePair('52.3676')).toBeUndefined()
    expect(LocationOverride.parsePair('1,2,3')).toBeUndefined()
    expect(LocationOverride.parsePair('abc, 4')).toBeUndefined()
  })

  it('range validation including the boundaries', () => {
    expect(LocationOverride.validateLatitude('90')).toBeUndefined()
    expect(LocationOverride.validateLatitude('-90')).toBeUndefined()
    expect(LocationOverride.validateLongitude('180')).toBeUndefined()
    expect(LocationOverride.validateLongitude('-180.0')).toBeUndefined()
    expect(LocationOverride.validateLatitude('91')).toBe('Latitude must be between -90 and 90')
    expect(LocationOverride.validateLongitude('-181')).toBe('Longitude must be between -180 and 180')
    expect(LocationOverride.validateLatitude(' ')).toBe('Latitude is required')
    expect(LocationOverride.validateLatitude('1e3')).toBeDefined()
    expect(LocationOverride.validateLatitude('52,3676')).toBeDefined()
    expect(LocationOverride.parse('52', '4').type).toBe('Ok')
    expect(LocationOverride.parse('52', '400').type).toBe('Invalid')
  })

  it('arguments use a dot and keep a negative latitude from being a flag', () => {
    expect(LocationOverride.setArgs(52.3676, 4.9041)).toEqual(['device', 'location', 'set', '52.3676,4.9041'])
    expect(LocationOverride.coordinateArg(-33.8688, 151.2093)).toBe(' -33.8688,151.2093')
    expect(LocationOverride.coordinateArg(40.7128, -74.006)).toBe('40.7128,-74.006')
    expect(LocationOverride.coordinateArg(-0.0, 0.0)).toBe('0,0')
    expect(LocationOverride.coordinateArg(90.0, -180.0)).toBe('90,-180')
  })

  it('saved places round trip and cannot shadow presets', () => {
    const home = place('Home | office', 52.0, 5.5)
    const saved = LocationOverride.savePlace([], home)!
    expect(saved[0].name).toBe('Home   office')
    expect(saved).toHaveLength(1)
    const again = LocationOverride.savePlace(saved, place('home   office', 1.0, 2.0))!
    expect(again).toHaveLength(1)
    expect(again[0].latitude).toBe(1.0)
    expect(LocationOverride.savePlace(saved, place('amsterdam', 1.0, 2.0))).toBeUndefined()
    expect(LocationOverride.savePlace(saved, place('  ', 1.0, 2.0))).toBeUndefined()
    expect(LocationOverride.decodePlaces(saved.map((p) => LocationOverride.encodePlace(p)))).toEqual(saved)
    expect(LocationOverride.deletePlace(saved, saved[0])).toEqual([])
    expect(LocationOverride.decodePlaces(['bad', 'x|95|1', 'y|a|b'])).toEqual([])
  })

  it('friendlyError falls back and keeps the first line, format rounds to 6 decimals', () => {
    expect(LocationOverride.friendlyError('')).toBe('Location command failed')
    expect(LocationOverride.friendlyError('  \n ')).toBe('Location command failed')
    expect(LocationOverride.friendlyError('\n\nfoo\nbar')).toBe('foo')
    expect(LocationOverride.format(52.36761234567)).toBe('52.367612')
    expect(LocationOverride.format(52.3676126)).toBe('52.367613')
  })

  it('presets are valid', () => {
    expect(LocationOverride.PRESETS).toHaveLength(5)
    for (const p of LocationOverride.PRESETS) {
      expect(LocationOverride.validateLatitude(String(p.latitude))).toBeUndefined()
      expect(LocationOverride.validateLongitude(String(p.longitude))).toBeUndefined()
    }
  })

  it('set builds the command and reads the success fixture', async () => {
    const out = fixture('location-set-ok.json')
    const runner = new FakeRunner(0, out)
    const result = await new MobilecliClient('/bin/mobilecli', runner).call('Pixel_9', LocationOverride.setArgs(-33.8688, 151.2093))
    expect(runner.last).toEqual(['/bin/mobilecli', 'device', 'location', 'set', ' -33.8688,151.2093', '--device', 'Pixel_9'])
    expect((MobilecliJson.data(result) as { latitude: number }).latitude).toBe(-33.8688)
  })

  it('errors come from stderr or the json envelope', async () => {
    const msg = async (r: FakeRunner) => {
      try {
        await new MobilecliClient('m', r).call('X', LocationOverride.CLEAR_ARGS)
      } catch (e) {
        return (e as Error).message
      }
      throw new Error('expected a failure')
    }
    const stderrOnly = fixture('location-set-range-error.txt')
    expect(LocationOverride.friendlyError(await msg(new FakeRunner(1, '', stderrOnly)))).toBe('latitude 91 out of range, must be between -90 and 90')
    expect(await msg(new FakeRunner(1, '{"status":"error","error":"device not found: nope"}', 'device not found: nope'))).toBe('device not found: nope')
  })
})
