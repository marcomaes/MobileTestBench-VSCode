// ported-from: core/MobilecliJson.kt

/** A mobilecli failure; the message is mobilecli's own error text. */
export class MobilecliException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobilecliException'
  }
}

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pure helpers for mobilecli calls: building the command line and reading the `{"status":..,"data":..}` envelope. */
export const MobilecliJson = {
  /** `mobilecli <args...> --device <id>`. */
  commandLine: (executable: string, id: string, args: string[]): string[] => [executable, ...args, '--device', id],

  /** The envelope as an object, or undefined when [stdout] is not one. */
  envelope(stdout: string): Record<string, Json> | undefined {
    try {
      const parsed = JSON.parse(stdout.trim())
      return isObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  },

  /** The text of mobilecli's error: the envelope's `error`, else stderr, else stdout, else [fallback]. */
  errorMessage(stdout: string, stderr: string, fallback = 'mobilecli failed'): string {
    const err = this.envelope(stdout)?.error
    const fromJson = typeof err === 'string' ? err : undefined
    return [fromJson, stderr.trim(), stdout.trim(), fallback].find((s) => s && s.trim().length > 0)!.trim()
  },

  /** True when stdout is an envelope with `"status":"error"`. */
  isError: (stdout: string): boolean => MobilecliJson.envelope(stdout)?.status === 'error',

  /** The `data` member of a successful envelope (undefined when absent or null). Throws [MobilecliException] on an error envelope. */
  data(stdout: string): Json | undefined {
    if (this.isError(stdout)) throw new MobilecliException(this.errorMessage(stdout, ''))
    const data = this.envelope(stdout)?.data
    return data === null ? undefined : data
  },
}
