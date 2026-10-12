// ported-from: core/logs/StackFrames.kt

const substringBeforeLast = (s: string, ch: string, missing: string): string => {
  const i = s.lastIndexOf(ch)
  return i < 0 ? missing : s.slice(0, i)
}

/** Kotlin `lineSequence`: splits on \n, \r\n and \r. */
const lineSequence = (s: string): string[] => s.split(/\r\n|\n|\r/)

/** One source location of a stack trace line. [className] and [method] are undefined for a bare `(Foo.kt:34)`. */
export class StackFrame {
  constructor(
    readonly className: string | undefined,
    readonly method: string | undefined,
    readonly file: string,
    readonly line: number,
  ) {}

  /** The package of [className] as a path (`com/example`), empty when unknown or in the default package. */
  get packagePath(): string {
    if (this.className === undefined) return ''
    const outer = this.className.split('$')[0]
    return substringBeforeLast(outer, '.', '').replaceAll('.', '/')
  }
}

/** Finds `at com.example.Foo.bar(Foo.java:12)` style frames in log messages. */
export const StackFrames = {
  // at [module/]pkg.Outer$Inner.method(File.java:12); methods like <init>, lambda$foo$0 and $r8$lambda$x are fine.
  full: /\bat\s+(?:[\w.$-]+\/)?([\w.$]+)\.([\w$<>]+)\(([\w$-]+\.(?:java|kt|kts)):(\d+)\)/,
  // (Foo.kt:34) without the rest
  bare: /\(([\w$-]+\.(?:java|kt|kts)):(\d+)\)/,

  /** The frame in one [line], or undefined. `(Native Method)`, `(Unknown Source:0)`, `(SourceFile:3)` and obfuscated forms do not match. */
  extract(line: string): StackFrame | undefined {
    const f = this.full.exec(line)
    if (f) {
      const n = Number.parseInt(f[4], 10)
      if (!Number.isFinite(n) || n <= 0) return undefined
      return new StackFrame(f[1], f[2], f[3], n)
    }
    const m = this.bare.exec(line)
    if (!m) return undefined
    const n = Number.parseInt(m[2], 10)
    return Number.isFinite(n) && n > 0 ? new StackFrame(undefined, undefined, m[1], n) : undefined
  },

  /** The first frame of a message of one or more lines. */
  extractFromMessage(message: string): StackFrame | undefined {
    return this.allFrames(message)[0]
  },

  /** Every frame of a multi line message, in order. */
  allFrames(message: string): StackFrame[] {
    return lineSequence(message)
      .map((l) => this.extract(l))
      .filter((f): f is StackFrame => f !== undefined)
  },

  /**
   * Picks the file for [frame] among [paths] (all with the frame's file name): those whose folder ends with the package path win,
   * else the first. Undefined when [paths] is empty.
   */
  choose(paths: string[], frame: StackFrame): string | undefined {
    if (paths.length <= 1) return paths[0]
    const pkg = frame.packagePath
    if (pkg.length > 0) {
      const hit = paths.find((p) => {
        const folder = substringBeforeLast(p.replaceAll('\\', '/'), '/', '')
        return folder.endsWith(`/${pkg}`) || folder === pkg
      })
      if (hit !== undefined) return hit
    }
    return paths[0]
  },
}
