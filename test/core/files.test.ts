// ported-from: test:core/FilesTest.kt
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import {
  AndroidFiles,
  EntryKind,
  FileEntry,
  FileErrors,
  FileFormat,
  FileParsers,
  FilePaths,
  FileSort,
  FilesException,
  IosFiles,
  runStreaming,
  SortKey,
} from '../../src/core/files/files'
import { MobilecliException } from '../../src/core/mobilecliJson'
import { fixture } from '../helpers/fixtures'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'mtb-files-'))

class Fake extends CommandRunner {
  readonly commands: string[][] = []
  constructor(private readonly answer: (command: string[]) => CommandResult) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command)
    return this.answer(command)
  }
}

const ok = (text = '') => new CommandResult(0, Buffer.from(text), '')
const err = (stderr: string, stdout = '', code = 1) => new CommandResult(code, Buffer.from(stdout), stderr)

/** A runner whose `start` runs a local shell instead of adb, to test the streaming of run-as pulls and pushes. */
class ShellRunner extends CommandRunner {
  constructor(private readonly script: (command: string[]) => string) {
    super({})
  }
  override start(command: string[], stdin: 'ignore' | 'pipe' = 'ignore'): ChildProcess {
    return spawn('sh', ['-c', this.script(command)], { stdio: [stdin, 'pipe', 'pipe'] })
  }
}

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a failure')
}

describe('FilesTest', () => {
  // paths

  it('joinParentNameNormalize', () => {
    expect(FilePaths.join('/sdcard', 'Download')).toBe('/sdcard/Download')
    expect(FilePaths.join('/', 'a')).toBe('/a')
    expect(FilePaths.join('/a/', 'b')).toBe('/a/b')
    expect(FilePaths.parent('/a/b')).toBe('/a')
    expect(FilePaths.parent('/a')).toBe('/')
    expect(FilePaths.parent('/')).toBe('/')
    expect(FilePaths.name('/a/b c/')).toBe('b c')
    expect(FilePaths.normalize('/a//b/../c/./')).toBe('/a/c')
    expect(FilePaths.normalize('/../..')).toBe('/')
  })

  it('rootBounds', () => {
    expect(FilePaths.isInside('/x/y', '/x/y/z')).toBe(true)
    expect(FilePaths.isInside('/x/y', '/x/y')).toBe(true)
    expect(FilePaths.isInside('/x/y', '/x/yy')).toBe(false)
    expect(FilePaths.isInside('/x/y', '/x/y/../z')).toBe(false)
    expect(FilePaths.isInside('/', '/anything')).toBe(true)
    expect(FilePaths.up('/x', '/x/y/z')).toBe('/x/y')
    expect(FilePaths.up('/x', '/x')).toBeUndefined()
    expect(FilePaths.up('/', '/sdcard')).toBe('/')
    expect(FilePaths.up('/', '/')).toBeUndefined()
  })

  it('shellQuoting', () => {
    expect(FilePaths.shellQuote('a b')).toBe("'a b'")
    expect(FilePaths.shellQuote("it's $HOME;x")).toBe("'it'\\''s $HOME;x'")
  })

  it('nameProblems', () => {
    expect(FilePaths.nameProblem('jbv scout')).toBeUndefined()
    expect(FilePaths.nameProblem('  ')).toBe('Enter a name')
    expect(FilePaths.nameProblem('a/b')).toContain('/')
    expect(FilePaths.nameProblem('..')).toContain('..')
    expect(FilePaths.nameProblem('a\nb')).toContain('line')
  })

  it('sizesAndDates', () => {
    expect(FileFormat.size(12)).toBe('12 B')
    expect(FileFormat.size(1536)).toBe('1.5 KB')
    expect(FileFormat.size(6 * 1024 * 1024)).toBe('6.0 MB')
    expect(FileFormat.modified(1791120432000, 'Europe/Amsterdam')).toBe('2026-10-04 15:27')
    expect(FileFormat.modified(undefined)).toBe('')
  })

  it('sortFoldersFirst', () => {
    const e = [FileEntry('b.txt', '/b.txt', false, 5, 10), FileEntry('Zeta', '/Zeta', true, 0, 5), FileEntry('a.txt', '/a.txt', false, 50, 1), FileEntry('alpha', '/alpha', true, 0, 9)]
    expect(FileSort.sort(e).map((x) => x.name)).toEqual(['alpha', 'Zeta', 'a.txt', 'b.txt'])
    expect(FileSort.sort(e, SortKey.NAME, false).map((x) => x.name)).toEqual(['Zeta', 'alpha', 'b.txt', 'a.txt'])
    expect(FileSort.sort(e, SortKey.SIZE).filter((x) => !x.isDir).map((x) => x.name)).toEqual(['b.txt', 'a.txt'])
    expect(FileSort.sort(e, SortKey.MODIFIED, false).filter((x) => !x.isDir).map((x) => x.name)).toEqual(['b.txt', 'a.txt'])
  })

  // parsers

  it('mobilecliLsAndroid', () => {
    const entries = FileParsers.parseMobilecliLs(fixture('mobilecli-fs-ls-android-root-symlinks.json'))
    const sdcard = entries.find((x) => x.name === 'sdcard')!
    expect(sdcard.path).toBe('/sdcard')
    expect(sdcard.isDir).toBe(false)
    expect(entries.find((x) => x.name === 'data')!.isDir).toBe(true)
  })

  it('mobilecliLsIosAppContainer', () => {
    const entries = FileParsers.parseMobilecliLs(fixture('mobilecli-fs-ls-ios-app-container.json'))
    expect(entries.map((x) => x.name)).toEqual(['Library', 'tmp'])
    expect(entries.every((x) => x.isDir && x.modifiedMillis !== undefined)).toBe(true)
    expect(FileParsers.parentOfEntries(entries)!.endsWith('/Containers/Data/Application/50A509E4-7327-4B18-A41C-ADA8C338B9B6')).toBe(true)
  })

  it('mobilecliLsEmptyAndError', () => {
    expect(FileParsers.parseMobilecliLs(fixture('mobilecli-fs-ls-empty.json'))).toEqual([])
    expect(FileParsers.parentOfEntries([])).toBeUndefined()
    let thrown: unknown
    try {
      FileParsers.parseMobilecliLs('{"status":"error","error":"failed to list files: no such file or directory"}')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MobilecliException)
    expect((thrown as Error).message).toContain('no such file')
  })

  it('statLines', () => {
    const out = [
      'directory|4096|1791120446|/sdcard/Download/jbv scout/a',
      'regular file|12|1791120432|/sdcard/Download/jbv scout/my file.txt',
      "directory|4096|1791120484|/sdcard/Download/jbv scout/it's $HOME;x",
      'symbolic link|7|1791120506|./lnk',
      'find: /data/data: Permission denied',
      'regular file|3|1|./a|b.txt',
    ].join('\n')
    const e = FileParsers.parseStatLines(out, '/sdcard/Download/jbv scout')
    expect(e.map((x) => x.name)).toEqual(['a', 'my file.txt', "it's $HOME;x", 'lnk', 'a|b.txt'])
    expect(e[0].isDir).toBe(true)
    expect(e[0].size).toBe(0)
    expect(e[1].size).toBe(12)
    expect(e[1].modifiedMillis).toBe(1791120432000)
    expect(e[1].path).toBe('/sdcard/Download/jbv scout/my file.txt')
    expect(e[3].isLink).toBe(true)
    expect(e[3].isDir).toBe(false)
  })

  it('statFixture', () => {
    const e = FileParsers.parseStatLines(fixture('android-run-as-find-stat.txt'), '/x')
    expect(e.some((x) => x.name === 'allb.bin' && x.size === 10240)).toBe(true)
  })

  it('errorMessages', () => {
    expect(FileErrors.message(err('', 'run-as: package not debuggable: com.x'), 'f')).toBe('run-as: package not debuggable: com.x')
    expect(FileErrors.message(err('boom', 'ignored'), 'f')).toBe('boom')
    expect(FileErrors.message(err('', ''), 'fallback')).toBe('fallback')
    expect(FileErrors.appDataHint('run-as: package not debuggable: com.x', 'com.x')).toContain('/sdcard/Android/data/com.x')
    expect(FileErrors.appDataHint('other', 'com.x')).toBe('other')
    expect(FileErrors.appDataHint('run-as: package not debuggable', undefined)).toBe('run-as: package not debuggable')
  })

  // Android backend

  it('androidDeviceStorageList', async () => {
    const r = new Fake(() => ok('directory|4096|1791120446|/sdcard/Download/a\n'))
    const files = new AndroidFiles('adb', 'emulator-5554', r)
    expect(files.home).toBe('/sdcard')
    expect(files.root).toBe('/')
    const list = await files.list('/sdcard/Download')
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('a')
    expect(r.commands).toEqual([['adb', '-s', 'emulator-5554', 'shell', "find '/sdcard/Download/' -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} +"]])
  })

  it('androidEmptyDirAndPartialFailure', async () => {
    expect(await new AndroidFiles('adb', 's', new Fake(() => ok())).list('/sdcard')).toEqual([])
    const partial = new AndroidFiles('adb', 's', new Fake(() => err('find: /x: Permission denied', 'regular file|1|1|/a/b\n')))
    expect(await partial.list('/a')).toHaveLength(1)
    const e = await rejection(new AndroidFiles('adb', 's', new Fake(() => err('find: /data/data: Permission denied'))).list('/data/data'))
    expect(e).toBeInstanceOf(FilesException)
    expect(e.message).toContain('Permission denied')
  })

  it('androidAppDataUsesRunAsWithRelativePaths', async () => {
    const r = new Fake(() => ok('regular file|440|1791120078|./AwOriginVisitLoggerPrefs.xml\n'))
    const files = new AndroidFiles('adb', 's', r, 'com.mobilenext.playground')
    expect(files.root).toBe('/data/user/0/com.mobilenext.playground')
    expect(files.home).toBe(files.root)
    expect(files.canDownloadFolder).toBe(false)
    const list = await files.list('/data/user/0/com.mobilenext.playground/shared_prefs')
    expect(list[0].path).toBe('/data/user/0/com.mobilenext.playground/shared_prefs/AwOriginVisitLoggerPrefs.xml')
    const cmd = r.commands[0]
    expect(cmd.slice(0, 4)).toEqual(['adb', '-s', 's', 'shell'])
    expect(cmd[4]).toBe("run-as com.mobilenext.playground sh -c 'find '\\''shared_prefs/'\\'' -mindepth 1 -maxdepth 1 -exec stat -c '\\''%F|%s|%Y|%n'\\'' {} +'")
    await files.list(files.root)
    expect(r.commands[r.commands.length - 1][4]).toContain("find '\\''./'\\''")
  })

  it('androidAppDataRefusesOutsidePaths', async () => {
    const files = new AndroidFiles('adb', 's', new Fake(() => ok()), 'com.x')
    expect((await rejection(files.list('/data/user/0/other'))).message).toContain('outside')
    expect((await rejection(files.mkdir('/data/user/0/com.x/../other/z'))).message).toContain('outside')
  })

  it('androidNotDebuggableGivesHint', async () => {
    const files = new AndroidFiles('adb', 's', new Fake(() => err('', 'run-as: package not debuggable: com.android.chrome')), 'com.android.chrome')
    const e = await rejection(files.list(files.root))
    expect(e.message).toContain('not debuggable')
    expect(e.message).toContain('/sdcard/Android/data/com.android.chrome')
  })

  it('androidKindReadMkdirDelete', async () => {
    const r = new Fake((c) => {
      const s = c[c.length - 1]
      if (s.startsWith('stat -L')) return ok('directory\n')
      if (s.startsWith('head -c')) return ok('hello')
      return ok()
    })
    const files = new AndroidFiles('adb', 's', r)
    const last = () => r.commands[r.commands.length - 1].at(-1)
    expect(await files.kindOf('/sdcard')).toBe(EntryKind.DIR)
    expect((await files.read('/sdcard/a b.txt', 100)).toString()).toBe('hello')
    expect(last()).toBe("head -c 100 '/sdcard/a b.txt'")
    await files.mkdir("/sdcard/Download/it's")
    expect(last()).toBe("mkdir '/sdcard/Download/it'\\''s'")
    await files.delete(FileEntry('d', '/sdcard/d', true, 0))
    expect(last()).toBe("rm -r '/sdcard/d'")
    await files.delete(FileEntry('f', '/sdcard/f', false, 3))
    expect(last()).toBe("rm '/sdcard/f'")
    const file = new AndroidFiles('adb', 's', new Fake(() => ok('regular file\n')))
    expect(await file.kindOf('/sdcard/x')).toBe(EntryKind.FILE)
  })

  it('androidDeviceStoragePullAndPush', async () => {
    const r = new Fake(() => ok('1 file pulled'))
    const files = new AndroidFiles('adb', 's', r)
    const folder = tmp()
    const out = await files.pull(FileEntry('my file.txt', '/sdcard/my file.txt', false, 12), folder)
    expect(out).toBe(join(folder, 'my file.txt'))
    expect(r.commands.at(-1)).toEqual(['adb', '-s', 's', 'pull', '/sdcard/my file.txt', out])
    await files.pull(FileEntry('dir', '/sdcard/dir', true, 0), folder)
    expect(r.commands.at(-1)).toEqual(['adb', '-s', 's', 'pull', '/sdcard/dir', folder])
    const local = join(tmp(), 'up.txt')
    writeFileSync(local, 'x')
    expect(await files.push(local, '/sdcard/Download')).toBe('/sdcard/Download/up.txt')
    expect(r.commands.at(-1)).toEqual(['adb', '-s', 's', 'push', local, '/sdcard/Download/up.txt'])
    const failing = new AndroidFiles('adb', 's', new Fake(() => err("adb: error: failed to stat remote object '/x': No such file or directory")))
    expect((await rejection(failing.pull(FileEntry('x', '/x', false, 1), folder))).message).toContain('No such file')
    expect(existsSync(join(folder, 'x'))).toBe(false)
  })

  it('androidAppDataPullStreamsBinary', async () => {
    const bytes = Buffer.from(Array.from({ length: 10240 }, (_, i) => i & 0xff))
    const src = join(tmp(), 'src.bin')
    writeFileSync(src, bytes)
    const files = new AndroidFiles('adb', 's', new ShellRunner(() => `cat '${src}'`), 'com.x')
    const folder = tmp()
    const out = await files.pull(FileEntry('src.bin', '/data/user/0/com.x/files/src.bin', false, 10240), folder)
    expect(readFileSync(out).equals(bytes)).toBe(true)
  })

  it('androidAppDataPullFailureDropsPartialFile', async () => {
    const files = new AndroidFiles('adb', 's', new ShellRunner(() => "echo 'run-as: package not debuggable: com.x'; exit 1"), 'com.x')
    const folder = tmp()
    expect((await rejection(files.pull(FileEntry('a', '/data/user/0/com.x/a', false, 1), folder))).message).toContain('not debuggable')
    expect(existsSync(join(folder, 'a'))).toBe(false)
    expect((await rejection(files.pull(FileEntry('d', '/data/user/0/com.x/d', true, 0), folder))).message).toContain('folder')
  })

  it('androidAppDataPullKeepsExistingFileOnFailure', async () => {
    const files = new AndroidFiles('adb', 's', new ShellRunner(() => "echo 'run-as: package not debuggable: com.x'; exit 1"), 'com.x')
    const folder = tmp()
    writeFileSync(join(folder, 'a'), 'old')
    await rejection(files.pull(FileEntry('a', '/data/user/0/com.x/a', false, 1), folder))
    expect(readFileSync(join(folder, 'a'), 'utf8')).toBe('old')
    expect(readdirSync(folder)).toEqual(['a'])
  })

  it('runStreamingTimeoutThrows', async () => {
    const out = join(tmp(), 'big')
    const e = await rejection(runStreaming(new ShellRunner(() => 'echo partial; sleep 30'), ['x'], undefined, out, 500))
    expect(e).toBeInstanceOf(FilesException)
    expect(e.message).toContain('Timed out')
  })

  it('runStreamingKeepsStderrAndStdoutText', async () => {
    const [code, text] = await runStreaming(new ShellRunner(() => 'echo out-text; echo err-text >&2; exit 2'), ['x'], undefined, undefined, 10_000)
    expect(code).toBe(2)
    expect(text.includes('out-text') && text.includes('err-text')).toBe(true)
  })

  it('androidPackageNameIsValidated', () => {
    for (const bad of ['com.x;reboot', 'a b', 'x$(id)', 'a|b', '`id`', '']) {
      expect(() => new AndroidFiles('adb', 's', new Fake(() => ok('')), bad), bad).toThrow(FilesException)
    }
    new AndroidFiles('adb', 's', new Fake(() => ok('')), 'com.mobilenext.playground')
  })

  it('androidAppDataPushStreamsStdin', async () => {
    const dest = join(tmp(), 'dest.bin')
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff))
    const local = join(tmp(), 'dest.bin')
    writeFileSync(local, bytes)
    const runner = new ShellRunner((cmd) => {
      expect(cmd.at(-1)).toBe("run-as com.x sh -c 'cat > '\\''files/dest.bin'\\'''")
      return `cat > '${dest}'`
    })
    const files = new AndroidFiles('adb', 's', runner, 'com.x')
    expect(await files.push(local, '/data/user/0/com.x/files')).toBe('/data/user/0/com.x/files/dest.bin')
    expect(readFileSync(dest).equals(bytes)).toBe(true)
  })

  // iOS backend

  const sim = '/Users/m/Library/Developer/CoreSimulator/Devices/U/data'

  it('iosRootFromListing', async () => {
    const root = await IosFiles.deviceRoot(async (args) => {
      expect(args).toEqual(['fs', 'ls'])
      return fixture('mobilecli-fs-ls-ios-app-container.json')
    })
    expect(root.endsWith('/Containers/Data/Application/50A509E4-7327-4B18-A41C-ADA8C338B9B6')).toBe(true)
  })

  it('iosContainerParsing', async () => {
    expect(IosFiles.parseContainer(ok('/a/b/\n'))).toBe('/a/b')
    expect(IosFiles.parseContainer(ok('(null)\n'))).toBeUndefined()
    expect(IosFiles.parseContainer(ok(''))).toBeUndefined()
    expect(IosFiles.parseContainer(err('No such file or directory', '', 2))).toBeUndefined()
    const e = await rejection(IosFiles.appContainer(new Fake(() => ok('(null)')), 'xcrun', 'U', 'com.apple.Preferences'))
    expect(e.message).toContain('no data container')
    const r = new Fake(() => ok(`${sim}/Containers/Data/Application/X/\n`))
    expect(await IosFiles.appContainer(r, 'xcrun', 'U', 'com.x')).toBe(`${sim}/Containers/Data/Application/X`)
    expect(r.commands).toEqual([['xcrun', 'simctl', 'get_app_container', 'U', 'com.x', 'data']])
  })

  it('iosCommandsUseAbsolutePathsInsideRoot', async () => {
    const calls: string[][] = []
    const files = new IosFiles(async (a) => (calls.push(a), '{"status":"ok","data":[]}'), sim, 'com.x')
    expect(files.isAppData).toBe(true)
    await files.list(`${sim}/Library`)
    await files.mkdir(`${sim}/tmp/new dir`)
    await files.delete(FileEntry('d', `${sim}/tmp/d`, true, 0))
    await files.delete(FileEntry('f', `${sim}/tmp/f`, false, 1))
    const local = join(tmp(), 'up.txt')
    writeFileSync(local, 'x')
    expect(await files.push(local, `${sim}/tmp`)).toBe(`${sim}/tmp/up.txt`)
    expect(calls).toEqual([
      ['fs', 'ls', `${sim}/Library`],
      ['fs', 'mkdir', `${sim}/tmp/new dir`],
      ['fs', 'rm', '-r', `${sim}/tmp/d`],
      ['fs', 'rm', `${sim}/tmp/f`],
      ['fs', 'push', local, `${sim}/tmp/up.txt`],
    ])
    for (const bad of ['/', 'relative', `${sim}/../x`, '-rf']) {
      expect((await rejection(files.list(bad))).message, bad).toContain('outside')
    }
  })

  it('iosKindProbe', async () => {
    const self = `{"status":"ok","data":[{"name":"f","path":"${sim}/f","size":3,"modTime":"2026-10-04T15:27:12.47366815+02:00","isDir":false}]}`
    const dir = `{"status":"ok","data":[{"name":"a","path":"${sim}/d/a","size":3,"isDir":false},{"name":"b","path":"${sim}/d/b","size":3,"isDir":false}]}`
    const files = new IosFiles(async (a) => (a.at(-1)!.endsWith('/f') ? self : a.at(-1)!.endsWith('/e') ? fixture('mobilecli-fs-ls-empty.json') : dir), sim)
    expect(await files.kindOf(`${sim}/f`)).toBe(EntryKind.FILE)
    expect(await files.kindOf(`${sim}/d`)).toBe(EntryKind.DIR)
    expect(await files.kindOf(`${sim}/e`)).toBe(EntryKind.DIR)
  })

  it('iosErrorTextIsShortened', async () => {
    const files = new IosFiles(async () => {
      throw new MobilecliException(`failed to list files: ls failed: open ${sim}/Library/x: no such file or directory`)
    }, sim)
    const e = await rejection(files.list(`${sim}/Library/x`))
    expect(e.message).toBe('failed to list files: ls failed: open <root>/Library/x: no such file or directory')
  })

  it('iosReadPullAndFolderCopy', async () => {
    const root = join(tmp(), 'root')
    mkdirSync(join(root, 'd'), { recursive: true })
    writeFileSync(join(root, 'd/a.txt'), 'hello world')
    const calls: string[][] = []
    const files = new IosFiles(async (a) => (calls.push(a), '{}'), root)
    expect((await files.read(`${root}/d/a.txt`, 5)).toString()).toBe('hello')
    expect((await files.read(`${root}/d/a.txt`, 500)).toString()).toBe('hello world')
    expect((await rejection(files.read(`${root}/d`, 5))).message).toContain('folder')
    expect((await rejection(files.read(`${root}/nope`, 5))).message).toContain('cannot be read')
    const dl = join(tmp(), 'dl')
    mkdirSync(dl)
    await files.pull(FileEntry('a.txt', `${root}/d/a.txt`, false, 11), dl)
    expect(calls.at(-1)).toEqual(['fs', 'pull', `${root}/d/a.txt`, join(dl, 'a.txt')])
    await files.pull(FileEntry('d', `${root}/d`, true, 0), dl)
    expect(readFileSync(join(dl, 'd/a.txt'), 'utf8')).toBe('hello world')
  })
})
