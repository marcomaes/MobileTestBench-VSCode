// ported-from: test:core/MemoryTest.kt
import { describe, expect, it } from 'vitest'
import { MemoryCommands, MemoryParsers, TrimLevels } from '../../src/core/memory/memory'

describe('MemoryTest', () => {
  it('buildsCommand', () => {
    expect(MemoryCommands.trim('adb', 'emulator-5554', 'com.example.app', 'RUNNING_CRITICAL')).toEqual([
      'adb', '-s', 'emulator-5554', 'shell', 'am', 'send-trim-memory', 'com.example.app', 'RUNNING_CRITICAL',
    ])
  })

  it('levelListIsCompleteAndOrdered', () => {
    expect(TrimLevels.values.map(TrimLevels.arg)).toEqual(['HIDDEN', 'RUNNING_MODERATE', 'BACKGROUND', 'RUNNING_LOW', 'MODERATE', 'RUNNING_CRITICAL', 'COMPLETE'])
  })

  it('validatesProcessNames', () => {
    expect(MemoryCommands.validProcess('com.example.app')).toBe(true)
    expect(MemoryCommands.validProcess('com.example.app:sync')).toBe(true)
    expect(MemoryCommands.validProcess('')).toBe(false)
    expect(MemoryCommands.validProcess('com.example; rm -rf /')).toBe(false)
    expect(MemoryCommands.validProcess('a b')).toBe(false)
  })

  it('findsErrors', () => {
    expect(MemoryParsers.error('')).toBeUndefined()
    expect(MemoryParsers.error('Unknown error: process com.x not found')).toBeDefined()
    expect(MemoryParsers.error('Error: Unknown level: FOO')).toBeDefined()
    expect(MemoryParsers.error('java.lang.SecurityException: denied')).toBeDefined()
    expect(MemoryParsers.errorLine('', 'boom\nmore', 1)).toBe('boom')
    expect(MemoryParsers.errorLine('', '', 3)).toBe('Exit code 3')
  })
})
