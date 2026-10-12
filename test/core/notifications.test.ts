// ported-from: test:core/NotificationsTest.kt
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'
import { AndroidNotifications, IosNotifications } from '../../src/core/notifications/notificationBackends'
import {
  androidPost,
  ApnsPayloads,
  apnsForm,
  historyEntry,
  historyLabel,
  intentSpec,
  NotificationCommands,
  PayloadHistory,
  PostStyles,
  sameEntry,
  type HistoryEntry,
} from '../../src/core/notifications/notifications'
import { fixture } from '../helpers/fixtures'

class FakeRunner extends CommandRunner {
  readonly commands: string[][] = []
  fileContent: string | undefined
  constructor(private readonly answer: (command: string[]) => CommandResult) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command)
    const last = command[command.length - 1]
    if (last?.endsWith('.json')) this.fileContent = readFileSync(last, 'utf8')
    return this.answer(command)
  }
}

const res = (out: string, exit = 0, err = '') => new CommandResult(exit, Buffer.from(out), err)

/** One captured command of a fixture file: its "$ ..." header, the output without the "[exit N]" line, and the exit code when recorded. */
interface Sample {
  header: string
  output: string
  exit: number | undefined
}

function samples(name: string): Sample[] {
  const out: Sample[] = []
  let header: string | undefined
  let body: string[] = []
  let exit: number | undefined
  const flush = () => {
    if (header !== undefined) {
      const fromHeader = /\(exit (\d+)\)/.exec(header)?.[1]
      out.push({ header, output: body.join('\n'), exit: exit ?? (fromHeader !== undefined ? Number(fromHeader) : undefined) })
    }
  }
  for (const line of fixture(name).split(/\r\n|\n|\r/)) {
    if (line.startsWith('$ ')) {
      flush()
      header = line
      body = []
      exit = undefined
    } else if (line.startsWith('[exit')) {
      const n = Number.parseInt(line.slice('[exit'.length).replace(/\]$/, '').trim(), 10)
      exit = Number.isNaN(n) ? undefined : n
    } else body.push(line)
  }
  flush()
  return out
}

const sample = (name: string, headerPart: string): Sample => samples(name).find((s) => s.header.includes(headerPart))!

describe('NotificationsTest', () => {
  it('buildsPayloadFromForm', () => {
    const p = ApnsPayloads.build(apnsForm({ title: 'Hi', subtitle: 'Sub', body: 'Body', badge: '3', sound: 'default', category: 'MSG', customJson: '{"id":42,"deep":{"a":[1,2]}}' }))
    expect(p.problem).toBeUndefined()
    expect(p.compact).toBe('{"aps":{"alert":{"title":"Hi","subtitle":"Sub","body":"Body"},"badge":3,"sound":"default","category":"MSG"},"id":42,"deep":{"a":[1,2]}}')
    expect(p.pretty).toContain('\n')
    expect(p.size).toBe(p.compact.length)
  })

  it('omitsBlankFieldsAndEscapes', () => {
    const p = ApnsPayloads.build(apnsForm({ body: 'say "hi" <b> \\ \n tab\t ünï ✓' }))
    expect(p.problem).toBeUndefined()
    expect(p.compact).toBe('{"aps":{"alert":{"body":"say \\"hi\\" <b> \\\\ \\n tab\\t ünï ✓"}}}')
    expect(p.size).toBeGreaterThan(p.compact.length)
  })

  it('formProblems', () => {
    expect(ApnsPayloads.build(apnsForm()).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ body: 'x', badge: 'x' })).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ body: 'x', badge: '-1' })).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ body: 'x', customJson: '[1]' })).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ body: 'x', customJson: '{bad' })).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ body: 'x', customJson: '{"aps":{}}' })).problem).toBeDefined()
    expect(ApnsPayloads.build(apnsForm({ badge: '0' })).problem).toBeUndefined()
  })

  it('inspectsRawPayloads', () => {
    expect(ApnsPayloads.inspect('{"aps":{"alert":"x"}}').problem).toBeUndefined()
    expect(ApnsPayloads.inspect('{nope').problem!.startsWith('Not valid JSON')).toBe(true)
    expect(ApnsPayloads.inspect('[1]').problem).toBeDefined()
    expect(ApnsPayloads.inspect('').problem).toBeDefined()
    expect(ApnsPayloads.inspect('{"x":1}').problem).toBeDefined()
    expect(ApnsPayloads.inspect('{"aps":"x"}').problem).toBeDefined()
    expect(ApnsPayloads.inspect('{"aps":{}}').problem).toBeDefined()
    expect(ApnsPayloads.inspect('{"aps":{"badge":"x"}}').problem).toBeDefined()
    expect(ApnsPayloads.inspect('{"aps":{"badge":2}}').problem).toBeUndefined()
    expect(ApnsPayloads.inspect('{ "aps" : { "alert" : "x" } }').compact).toBe('{"aps":{"alert":"x"}}')
  })

  it('sizeLimitIsInclusiveAndCountsBytes', () => {
    const payloadOfSize = (n: number) => {
      const base = '{"aps":{"alert":""}}'
      return `{"aps":{"alert":"${'a'.repeat(n - base.length)}"}}`
    }
    expect(ApnsPayloads.inspect(payloadOfSize(4096)).size).toBe(4096)
    expect(ApnsPayloads.inspect(payloadOfSize(4096)).oversize).toBe(false)
    expect(ApnsPayloads.inspect(payloadOfSize(4097)).oversize).toBe(true)
    // a 3 byte character counts three times
    const multi = ApnsPayloads.build(apnsForm({ body: '日'.repeat(1400) }))
    expect(multi.oversize).toBe(true)
    expect(ApnsPayloads.byteSize('日')).toBe(3)
  })

  it('shellQuoteProtectsEverything', () => {
    expect(NotificationCommands.shellQuote('plain')).toBe("'plain'")
    expect(NotificationCommands.shellQuote("it's")).toBe("'it'\\''s'")
    expect(NotificationCommands.shellQuote('$HOME; & | `x` "q" ünï ✓ 日本')).toBe("'$HOME; & | `x` \"q\" ünï ✓ 日本'")
    expect(NotificationCommands.shellQuote('')).toBe("''")
  })

  it('postCommandsPerStyle', () => {
    expect(NotificationCommands.androidPost(androidPost({ title: 'Hello title', text: 'Body text', tag: 'tag' }))).toBe("cmd notification post -t 'Hello title' 'tag' 'Body text'")
    expect(NotificationCommands.androidPost(androidPost({ title: 'T', text: 'text', style: PostStyles.BIGTEXT, tag: 'tag' }))).toBe("cmd notification post -S bigtext -t 'T' 'tag' 'text'")
    expect(NotificationCommands.androidPost(androidPost({ title: 'T', text: 'summary', style: PostStyles.INBOX, tag: 'tag', lines: ['line one', '', 'line two'] }))).toBe(
      "cmd notification post -S inbox --line 'line one' --line 'line two' -t 'T' 'tag' 'summary'",
    )
    expect(NotificationCommands.androidPost(androidPost({ text: 'x', style: PostStyles.MESSAGING, tag: 'tag', conversation: 'Chat', messages: ['Bob:hi', 'Ann:yo'] }))).toBe(
      "cmd notification post -S messaging --conversation 'Chat' --message 'Bob:hi' --message 'Ann:yo' 'tag' 'x'",
    )
    expect(NotificationCommands.androidPost(androidPost({ title: 'it\'s "q" $HOME; & |', text: 'ünï ✓ 日本', tag: 't' }))).toBe(
      "cmd notification post -t 'it'\\''s \"q\" $HOME; & |' 't' 'ünï ✓ 日本'",
    )
  })

  it('postValidation', () => {
    const problem = NotificationCommands.postProblem
    expect(problem(androidPost({ text: 'x' }))).toBeUndefined()
    expect(problem(androidPost({ text: '' }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', tag: ' ' }))).toBeDefined()
    expect(problem(androidPost({ text: 'a\nb' }))).toBeDefined()
    expect(problem(androidPost({ title: 'a\nb', text: 'x' }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', style: PostStyles.INBOX }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', style: PostStyles.MESSAGING, conversation: 'c' }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', style: PostStyles.MESSAGING, conversation: 'c', messages: ['nocolon'] }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', style: PostStyles.MESSAGING, messages: ['a:b'] }))).toBeDefined()
    expect(problem(androidPost({ text: 'x', style: PostStyles.MESSAGING, conversation: 'c', messages: ['a:b'] }))).toBeUndefined()
  })

  it('parsesExtras', () => {
    const [extras, err] = NotificationCommands.parseExtras('# comment\n\nname=a b=c\ni:n=5\nz:b=true\nl:big=123\nf:x=1.5\ns:k=v\n')
    expect(err).toBeUndefined()
    expect(extras.map((e) => [e.flag, e.key])).toEqual([
      ['--es', 'name'],
      ['--ei', 'n'],
      ['--ez', 'b'],
      ['--el', 'big'],
      ['--ef', 'x'],
      ['--es', 'k'],
    ])
    expect(extras[0].value).toBe('a b=c')
    expect(NotificationCommands.parseExtras('novalue')[1]).toBeDefined()
    expect(NotificationCommands.parseExtras('=x')[1]).toBeDefined()
    expect(NotificationCommands.parseExtras('i:n=abc')[1]).toBeDefined()
    expect(NotificationCommands.parseExtras('z:b=yes')[1]).toBeDefined()
    expect(NotificationCommands.parseExtras('a b=c')[1]).toBeDefined()
  })

  it('broadcastCommand', () => {
    const spec = intentSpec({ action: 'com.example.TEST', pkg: 'com.pkg', component: 'com.pkg/.Receiver', extras: 'key=v w\ni:n=5\nz:b=true' })
    expect(NotificationCommands.broadcastProblem(spec)).toBeUndefined()
    expect(NotificationCommands.androidBroadcast(spec)).toBe("am broadcast -a 'com.example.TEST' -n 'com.pkg/.Receiver' --es 'key' 'v w' --ei 'n' '5' --ez 'b' 'true'")
    expect(NotificationCommands.androidBroadcast(intentSpec({ action: 'x', pkg: 'com.pkg' }))).toBe("am broadcast -a 'x' -p 'com.pkg'")
    expect(NotificationCommands.androidBroadcast(intentSpec({ action: "it's" }))).toBe("am broadcast -a 'it'\\''s'")
    expect(NotificationCommands.broadcastProblem(intentSpec())).toBeDefined()
    expect(NotificationCommands.broadcastProblem(intentSpec({ component: 'NoSlash' }))).toBeDefined()
    expect(NotificationCommands.broadcastProblem(intentSpec({ action: 'a b' }))).toBeDefined()
    expect(NotificationCommands.broadcastProblem(intentSpec({ action: 'a', extras: 'bad' }))).toBeDefined()
  })

  it('commandIsOneArgumentForAdb', () => {
    expect(NotificationCommands.adbShell('adb', 'emulator-5554', "cmd notification post -t 'a b' 't' 'x'")).toEqual(['adb', '-s', 'emulator-5554', 'shell', "cmd notification post -t 'a b' 't' 'x'"])
    expect(NotificationCommands.iosPush('xcrun', 'U', 'com.app', '/tmp/p.json')).toEqual(['xcrun', 'simctl', 'push', 'U', 'com.app', '/tmp/p.json'])
  })

  it('validatesBundleIds', () => {
    expect(NotificationCommands.validBundleId('com.mobilenext.playground')).toBe(true)
    expect(NotificationCommands.validBundleId('')).toBe(false)
    expect(NotificationCommands.validBundleId('-x')).toBe(false)
    expect(NotificationCommands.validBundleId('a b')).toBe(false)
  })

  it('interpretsIosFixtures', () => {
    const text = fixture('ios-simctl-push-outputs.txt')
    expect(text).toContain("Notification sent to 'com.mobilenext.playground'")
    const ok = NotificationCommands.interpretIosPush(0, "Notification sent to 'com.mobilenext.playground'\n", '')
    expect(ok.error).toBe(false)
    expect(ok.text).toBe("Notification sent to 'com.mobilenext.playground'")
    // invalid JSON exits 0 with empty stdout: still an error, stderr verbatim
    const bad = NotificationCommands.interpretIosPush(0, '', 'An error was encountered processing the command (domain=NSCocoaErrorDomain, code=3840):\nThe data couldn’t be read')
    expect(bad.error).toBe(true)
    expect(bad.text.startsWith('An error was encountered')).toBe(true)
    const big = NotificationCommands.interpretIosPush(28, '', 'Payload too large, must be 4096 bytes or less')
    expect(big.error).toBe(true)
    expect(NotificationCommands.interpretIosPush(1, '', '').error).toBe(true)
  })

  it('capturedSimctlOutputsGoThroughTheParser', () => {
    const f = 'ios-simctl-push-outputs.txt'
    const ok = sample(f, '(ok)')
    const r = NotificationCommands.interpretIosPush(0, ok.output, '')
    expect(r.error).toBe(false)
    expect(r.text).toBe("Notification sent to 'com.mobilenext.playground'")
    // an unknown bundle id is still reported as sent (the simulator does not check)
    expect(NotificationCommands.interpretIosPush(0, sample(f, 'unknown bundle').output, '').error).toBe(false)
    // invalid JSON: exit 0, stdout empty, error on stderr
    const bad = sample(f, 'invalid JSON')
    const badR = NotificationCommands.interpretIosPush(0, '', bad.output)
    expect(badR.error).toBe(true)
    expect(badR.text.startsWith('An error was encountered processing the command (domain=NSCocoaErrorDomain, code=3840)')).toBe(true)
    for (const h of ['missing aps', 'aps wrong value', 'root not an object', 'too large', 'missing file', 'invalid device']) {
      const s = sample(f, h)
      const result = NotificationCommands.interpretIosPush(s.exit ?? 1, '', s.output)
      expect(result.error, h).toBe(true)
      expect(result.text, h).toBe(s.output.trim())
    }
  })

  it('capturedBroadcastOutputsGoThroughTheParser', () => {
    const all = samples('android-am-broadcast-outputs.txt')
    expect(all).toHaveLength(4)
    for (const s of all.slice(0, 2)) {
      const r = NotificationCommands.interpretBroadcast(0, s.output, '')
      expect(r.error, s.header).toBe(false)
      expect(r.text.endsWith('Broadcast completed: result=0')).toBe(true)
      expect(r.text.startsWith('Broadcasting: Intent {')).toBe(true)
    }
    const noIntent = NotificationCommands.interpretBroadcast(255, all[2].output, '')
    expect(noIntent.error).toBe(true)
    expect(noIntent.text).toBe('java.lang.IllegalArgumentException: No intent supplied')
    const badNumber = NotificationCommands.interpretBroadcast(255, all[3].output, '')
    expect(badNumber.error).toBe(true)
    expect(badNumber.text).toBe('java.lang.NumberFormatException: For input string: "notanumber"')
  })

  it('capturedAndroidPostOutputsGoThroughTheParser', () => {
    const f = 'android-cmd-notification-post.txt'
    const ok = NotificationCommands.interpretAndroidPost(0, sample(f, "-t 'Hello title'").output, '')
    expect(ok.error).toBe(false)
    expect(ok.text.startsWith('posting for user 0:')).toBe(true)
    const bad = sample(f, '-S foo')
    const r = NotificationCommands.interpretAndroidPost(bad.exit ?? 0, bad.output, '')
    expect(r.error).toBe(true)
    expect(r.text).toContain('unrecognized notification style: foo')
  })

  it('interpretsAndroidOutputs', () => {
    const post = NotificationCommands.interpretAndroidPost(0, 'posting for user 0:\n  Notification(channel=shell_cmd ...)\n', '')
    expect(post.error).toBe(false)
    expect(post.text).toBe('posting for user 0:\n  Notification(channel=shell_cmd ...)')
    expect(NotificationCommands.interpretAndroidPost(0, 'Error occurred. Check logcat for details. unrecognized notification style: foo', '').error).toBe(true)
    expect(NotificationCommands.interpretAndroidPost(0, 'Unknown command: cancel', '').error).toBe(true)
    expect(fixture('android-cmd-notification-post.txt')).toContain('-S|--style')
  })

  it('interpretsBroadcastFixtures', () => {
    expect(fixture('android-am-broadcast-outputs.txt')).toContain('Broadcast completed: result=0')
    const ok = NotificationCommands.interpretBroadcast(0, 'Broadcasting: Intent { act=a }\nBroadcast completed: result=0\n', '')
    expect(ok.error).toBe(false)
    expect(ok.text).toBe('Broadcasting: Intent { act=a } | Broadcast completed: result=0')
    const noIntent = NotificationCommands.interpretBroadcast(
      255,
      "\nException occurred while executing 'broadcast':\njava.lang.IllegalArgumentException: No intent supplied\n\tat android.content.Intent.parseCommandArgs(Intent.java:9181)\n",
      '',
    )
    expect(noIntent.error).toBe(true)
    expect(noIntent.text).toBe('java.lang.IllegalArgumentException: No intent supplied')
    expect(NotificationCommands.interpretBroadcast(0, '', '').error).toBe(true)
  })

  it('countsShellNotifications', () => {
    expect(NotificationCommands.shellNotificationCount('0|com.android.shell|2020|jbvm_t2|2000\n0|com.android.vending|5|x|10100\n')).toBe(1)
    expect(NotificationCommands.shellNotificationCount('0|com.android.vending|5|x|10100\n')).toBe(0)
    expect(NotificationCommands.shellNotificationCount('')).toBe(0)
  })

  it('iosPushWritesCompactPayloadToTempFileAndDeletesIt', async () => {
    const runner = new FakeRunner(() => res("Notification sent to 'com.app'\n"))
    const r = await new IosNotifications('xcrun', 'UDID', runner).push('com.app', '{"aps":{"alert":"é"}}')
    expect(r.error).toBe(false)
    expect(runner.fileContent).toBe('{"aps":{"alert":"é"}}')
    const cmd = runner.commands[0]
    expect(runner.commands).toHaveLength(1)
    expect(cmd.slice(0, 5)).toEqual(['xcrun', 'simctl', 'push', 'UDID', 'com.app'])
    expect(existsSync(cmd[cmd.length - 1])).toBe(false)
  })

  it('androidBackendSendsOneShellString', async () => {
    const runner = new FakeRunner((c) => {
      const s = c[c.length - 1]
      if (s.startsWith('cmd notification list')) return res('0|com.android.vending|5|x|1\n')
      if (s.startsWith('cmd notification post')) return res('posting for user 0:\n')
      return res('Broadcast completed: result=0\n')
    })
    const b = new AndroidNotifications('adb', 'emulator-5554', runner)
    expect((await b.post(androidPost({ title: 'a b', text: 'x', tag: 't' }))).error).toBe(false)
    expect(runner.commands[0]).toEqual(['adb', '-s', 'emulator-5554', 'shell', "cmd notification post -t 'a b' 't' 'x'"])
    expect((await b.broadcast(intentSpec({ action: 'act' }))).error).toBe(false)
    expect(runner.commands[1][runner.commands[1].length - 1]).toBe("am broadcast -a 'act'")
    const cleared = await b.clearShell()
    expect(cleared.error).toBe(false)
    expect(runner.commands[2][runner.commands[2].length - 1]).toBe(NotificationCommands.CLEAR_SHELL)
    expect(runner.commands[3][runner.commands[3].length - 1]).toBe(NotificationCommands.LIST)
  })

  it('clearReportsRemainingNotifications', async () => {
    const runner = new FakeRunner((c) => (c[c.length - 1] === NotificationCommands.LIST ? res('0|com.android.shell|2020|t|2000\n') : res('Result: Parcel(...)')))
    const r = await new AndroidNotifications('adb', 's', runner).clearShell()
    expect(r.error).toBe(true)
    expect(r.text.startsWith('1 shell notification')).toBe(true)
  })

  it('runnerFailureBecomesErrorResult', async () => {
    const runner = new (class extends CommandRunner {
      override async run(): Promise<CommandResult> {
        throw new Error('adb not found')
      }
    })({})
    const r = await new AndroidNotifications('adb', 's', runner).post(androidPost({ text: 'x' }))
    expect(r.error).toBe(true)
    expect(r.text).toBe('adb not found')
  })

  it('historyKeepsNewestFirstDedupesAndCaps', () => {
    let list: HistoryEntry[] = []
    for (let i = 1; i <= 20; i++) list = PayloadHistory.add(list, historyEntry('ios', { bundle: 'b', payload: `{"aps":{"badge":${i}}}` }))
    expect(list).toHaveLength(15)
    expect(list[0].fields.payload).toContain('20')
    expect(list[list.length - 1].fields.payload).toContain('6}')
    const again = historyEntry('ios', { bundle: 'b', payload: '{"aps":{"badge":10}}' })
    list = PayloadHistory.add(list, again)
    expect(list).toHaveLength(15)
    expect(list[0]).toEqual(again)
    expect(list.filter((e) => sameEntry(e, again))).toHaveLength(1)
  })

  it('historySerializesAndSkipsBadLines', () => {
    const e = historyEntry('post', { title: 'it\'s "q"\nline', text: '日本', tag: 't' })
    const line = PayloadHistory.serialize(e)
    expect(line).not.toContain('\n')
    expect(PayloadHistory.parse(line)).toEqual(e)
    expect(PayloadHistory.parse('garbage')).toBeUndefined()
    expect(PayloadHistory.parse('{"kind":"x"}')).toBeUndefined()
    expect(PayloadHistory.load(['garbage', line])).toEqual([e])
    expect(PayloadHistory.load(Array.from({ length: 30 }, (_, i) => PayloadHistory.serialize(historyEntry('intent', { action: `a${i}` }))))).toHaveLength(15)
    expect(historyLabel(e).startsWith('Post t:')).toBe(true)
    expect(historyLabel(historyEntry('ios', { bundle: 'com.a', payload: '{ "aps" : { "alert": "x" } }' }))).toContain('{"aps":{"alert":"x"}}')
  })
})
