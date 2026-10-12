// No Kotlin counterpart: java.util.Formatter's "%.Nf" rounds HALF_UP on the shortest decimal form of a double
// (1.005 gives "1.01"), while Number.toFixed rounds the exact binary value (1.00). This reproduces the Java result.

/** `"%.${digits}f".format(Locale.ROOT, value)`. */
export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
  const shortest = String(Math.abs(value))
  if (/e/i.test(shortest)) return value.toFixed(digits)
  const negative = value < 0 || Object.is(value, -0)
  let [whole, frac = ''] = shortest.split('.')
  let roundUp = false
  if (frac.length > digits) {
    roundUp = frac.charCodeAt(digits) >= 53 // '5'
    frac = frac.slice(0, digits)
  } else {
    frac = frac.padEnd(digits, '0')
  }
  let digitsText = whole + frac
  if (roundUp) {
    const chars = digitsText.split('')
    let i = chars.length - 1
    while (i >= 0) {
      if (chars[i] === '9') {
        chars[i] = '0'
        i--
      } else {
        chars[i] = String(Number(chars[i]) + 1)
        break
      }
    }
    digitsText = (i < 0 ? '1' : '') + chars.join('')
  }
  whole = digitsText.slice(0, digitsText.length - digits)
  frac = digitsText.slice(digitsText.length - digits)
  const text = digits > 0 ? `${whole}.${frac}` : whole
  return negative && /[1-9]/.test(digitsText) ? `-${text}` : negative ? `-${text}` : text
}
