// ported-from: core/logs/Logs.kt
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { LogEntry } from './logs'

/** The pids below [root] (children, grandchildren, ...), from one `ps` call. Empty when ps is not available. */
function descendantsOf(root: number): number[] {
  if (process.platform === 'win32') return []
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
    const children = new Map<number, number[]>()
    for (const line of out.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      children.set(ppid, [...(children.get(ppid) ?? []), pid])
    }
    const found: number[] = []
    const queue = [root]
    while (queue.length) for (const c of children.get(queue.shift()!) ?? []) (found.push(c), queue.push(c))
    return found
  } catch {
    return []
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const signal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig)
  } catch {
    // already gone
  }
}

/**
 * Reads a device log (a long running process such as `adb logcat`) and hands out entries. A line that is not
 * the start of an entry continues the previous one (multi line messages, stack traces).
 */
export class LogStream {
  private constructor(private readonly child: ChildProcess) {}

  /**
   * Ends the process and everything it started: `mobilecli` is a wrapper around a native child that would otherwise keep running
   * (and keep the device side log process alive). Anything still alive after about two seconds is killed.
   */
  close(): void {
    const pid = this.child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        this.child.kill()
      }
      return
    }
    const children = descendantsOf(pid)
    children.forEach((c) => signal(c, 'SIGTERM'))
    this.child.kill('SIGTERM')
    const all = [pid, ...children]
    if (all.some(alive)) {
      const timer = setTimeout(() => all.forEach((p) => alive(p) && signal(p, 'SIGKILL')), 2000)
      timer.unref()
    }
  }

  /**
   * Runs [launch] (it returns the process to read) and reads it. [parse] turns a line into an entry or undefined;
   * [onEntry] and [onEnd] are called as data arrives. [onEnd] gets what the process said on stderr (undefined when nothing).
   */
  static start(
    launch: () => ChildProcess,
    parse: (line: string) => LogEntry | undefined,
    onEntry: (entry: LogEntry) => void,
    onEnd: (error: string | undefined) => void,
  ): LogStream {
    const child = launch()
    const stream = new LogStream(child)
    let errors = ''
    let pending: LogEntry | undefined
    let partial = ''
    let ended = false
    const decoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const handleLine = (text: string): void => {
      const entry = parse(text)
      if (entry) {
        if (pending) onEntry(pending)
        pending = entry
      } else if (pending && text.trim().length > 0) {
        pending.message += '\n' + text
      }
    }
    const finish = (error?: string): void => {
      if (ended) return
      ended = true
      if (partial.length > 0) handleLine(partial.replace(/\r$/, ''))
      partial = ''
      if (pending) onEntry(pending)
      pending = undefined
      onEnd((error ?? errors.trim()) || undefined)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = (partial + decoder.write(chunk)).split('\n')
      partial = lines.pop() ?? ''
      for (const l of lines) handleLine(l.replace(/\r$/, ''))
      // Nothing more buffered: the message is complete, do not hold it back until the next line.
      if (partial.length === 0 && pending) {
        onEntry(pending)
        pending = undefined
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errors.length < 2048) errors += errDecoder.write(chunk)
    })
    child.on('error', (e) => finish(e.message))
    // 'close' comes after both streams ended, so stderr has been read in full.
    child.on('close', () => finish())
    return stream
  }
}
