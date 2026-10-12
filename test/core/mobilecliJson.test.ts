// ported-from: test:core/MobilecliJsonTest.kt
import { describe, expect, it } from 'vitest'
import { MobilecliClient } from '../../src/core/ios/mobilecliClient'
import { MobilecliException, MobilecliJson } from '../../src/core/mobilecliJson'
import { fail, ok, RecordingRunner } from '../helpers/fakeRunner'

describe('MobilecliJson', () => {
  it('command line puts the device last', () => {
    expect(MobilecliJson.commandLine('mobilecli', 'Pixel_9', ['apps', 'list'])).toEqual(['mobilecli', 'apps', 'list', '--device', 'Pixel_9'])
  })

  it('data of an ok envelope', () => {
    const data = MobilecliJson.data('{"status":"ok","data":{"a":[1,2]}}') as { a: number[] }
    expect(data.a).toHaveLength(2)
    expect(MobilecliJson.data('{"status":"ok"}')).toBeUndefined()
    expect(MobilecliJson.data('not json')).toBeUndefined()
  })

  it("error envelope gives mobilecli's text", () => {
    expect(MobilecliJson.errorMessage('{"status":"error","error":"device not found"}', '')).toBe('device not found')
    expect(MobilecliJson.errorMessage('', 'boom\n')).toBe('boom')
    expect(MobilecliJson.errorMessage('', '')).toBe('mobilecli failed')
    let thrown: unknown
    try {
      MobilecliJson.data('{"status":"error","error":"nope"}')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MobilecliException)
    expect((thrown as Error).message).toBe('nope')
  })

  it('call returns stdout and builds the command', async () => {
    const runner = new RecordingRunner(() => ok('{"status":"ok","data":[]}'))
    const out = await new MobilecliClient('/bin/mobilecli', runner).call('X', ['apps', 'list'])
    expect(out).toBe('{"status":"ok","data":[]}')
    expect(runner.commands[0]).toEqual(['/bin/mobilecli', 'apps', 'list', '--device', 'X'])
  })

  it('call fails with the json error, stderr, or error envelope on exit 0', async () => {
    const msg = async (r: RecordingRunner) => ((await new MobilecliClient('m', r).call('X', ['a']).catch((e) => e)) as Error).message
    expect(await msg(new RecordingRunner(() => fail('{"status":"error","error":"bad"}')))).toBe('bad')
    expect(await msg(new RecordingRunner(() => fail('', 'stderr text')))).toBe('stderr text')
    expect(await msg(new RecordingRunner(() => ok('{"status":"error","error":"soft"}')))).toBe('soft')
  })
})
