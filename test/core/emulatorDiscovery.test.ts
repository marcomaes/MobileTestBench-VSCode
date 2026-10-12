// ported-from: test:core/ParsersTest.kt
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmulatorDiscovery } from '../../src/core/android/emulatorDiscovery'

describe('emulator discovery', () => {
  it('finds emulator grpc endpoint from discovery file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avd-running'))
    try {
      await writeFile(join(dir, 'pid_1234.ini'), 'port.serial=5556\nport.adb=5557\navd.name=Pixel_8_API_35\ngrpc.port=8556\ngrpc.token=secret-token')
      await writeFile(join(dir, 'pid_999.ini'), 'port.serial=5554\ngrpc.port=8554\n')

      const endpoint = (await EmulatorDiscovery.findEndpoint('emulator-5556', [dir]))!
      expect(endpoint.port).toBe(8556)
      expect(endpoint.token).toBe('secret-token')

      const noToken = (await EmulatorDiscovery.findEndpoint('emulator-5554', [dir]))!
      expect(noToken.port).toBe(8554)
      expect(noToken.token).toBeUndefined()

      expect(await EmulatorDiscovery.findEndpoint('emulator-5560', [dir])).toBeUndefined()
      expect(await EmulatorDiscovery.findEndpoint('R58M123ABC', [dir])).toBeUndefined()
      expect(await EmulatorDiscovery.findEndpoint('emulator-5556', [join(dir, 'missing')])).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('default directories follow the platform', () => {
    expect(EmulatorDiscovery.defaultDirectories({ ANDROID_EMULATOR_HOME: '/h' }, 'Mac OS X', '/Users/me')).toEqual(['/h/running', '/Users/me/Library/Caches/TemporaryItems/avd/running'])
    expect(EmulatorDiscovery.defaultDirectories({ USER: 'me', XDG_RUNTIME_DIR: '/run/user/1' }, 'linux', '/home/me')).toEqual(['/run/user/1/avd/running', '/tmp/android-me/avd/running'])
  })
})
