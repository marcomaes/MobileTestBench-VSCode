// ported-from: core/recording/TextClearing.kt
import type { Platform } from '../model'
import type { DeviceSession } from '../session/deviceSession'

/**
 * Empties the focused text field the way Mobilewright's own driver does (select all, then backspace), because
 * `fill` replaces text. Kept in one place so the method can change per platform.
 */
export const TextClearing = {
  /**
   * Android takes ctrl+a. iOS needs cmd+a: there ctrl+a is the Emacs "beginning of line", so ctrl+a + backspace
   * would leave the text untouched.
   */
  keysFor(platform: Platform): string[] {
    return platform === 'ANDROID' ? ['ctrl+a', 'backspace'] : ['cmd+a', 'backspace']
  },

  /**
   * One key call. It succeeds silently when nothing is focused, so it never proves the field is empty:
   * the caller has to read the field back.
   */
  clearFocusedText(session: DeviceSession): Promise<void> {
    return session.pressKeys(TextClearing.keysFor(session.device.platform))
  },
}
