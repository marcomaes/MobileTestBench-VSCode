// No Kotlin counterpart: replaces javax.xml (SafeXml in core/inspector/HierarchyParsers.kt, the DTD safe plist reader in core/files/Preview.kt).

export interface XmlElement {
  readonly tagName: string
  readonly attributes: Record<string, string>
  readonly children: XmlElement[]
  /** Concatenated character data directly inside the element. */
  text: string
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return entities[body] ?? whole
  })
}

/**
 * Small non validating XML parser for device output (uiautomator, WDA source, plist, shared preferences).
 * Rejects DOCTYPE (no entity expansion attacks), skips comments and processing instructions, tolerates text
 * before the first element and after the last one (uiautomator prints a status line after the XML).
 */
export function parseXml(xml: string): XmlElement {
  const start = xml.indexOf('<')
  if (start < 0) throw new Error('No XML found in hierarchy output')
  const end = xml.lastIndexOf('>')
  const src = xml.slice(start, end + 1)
  let i = 0
  const stack: XmlElement[] = []
  let root: XmlElement | undefined

  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i)
      const raw = next < 0 ? src.slice(i) : src.slice(i, next)
      if (stack.length) stack[stack.length - 1].text += decodeEntities(raw)
      i = next < 0 ? src.length : next
      continue
    }
    if (src.startsWith('<!--', i)) {
      const close = src.indexOf('-->', i + 4)
      if (close < 0) throw new Error('Unterminated XML comment')
      i = close + 3
    } else if (src.startsWith('<![CDATA[', i)) {
      const close = src.indexOf(']]>', i + 9)
      if (close < 0) throw new Error('Unterminated CDATA')
      if (stack.length) stack[stack.length - 1].text += src.slice(i + 9, close)
      i = close + 3
    } else if (src.startsWith('<?', i)) {
      const close = src.indexOf('?>', i + 2)
      if (close < 0) throw new Error('Unterminated processing instruction')
      i = close + 2
    } else if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
      throw new Error('DOCTYPE is not allowed')
    } else if (src.startsWith('</', i)) {
      const close = src.indexOf('>', i)
      if (close < 0) throw new Error('Unterminated closing tag')
      const name = src.slice(i + 2, close).trim()
      const open = stack.pop()
      if (!open || open.tagName !== name) throw new Error(`Unexpected closing tag </${name}>`)
      i = close + 1
    } else {
      const tag = readTag(src, i)
      const element: XmlElement = { tagName: tag.name, attributes: tag.attributes, children: [], text: '' }
      if (stack.length) stack[stack.length - 1].children.push(element)
      else if (!root) root = element
      if (!tag.selfClosing) stack.push(element)
      i = tag.next
    }
  }
  if (!root) throw new Error('No XML element found')
  if (stack.length) throw new Error(`Unclosed element <${stack[stack.length - 1].tagName}>`)
  return root
}

function readTag(src: string, from: number): { name: string; attributes: Record<string, string>; selfClosing: boolean; next: number } {
  let i = from + 1
  const nameStart = i
  while (i < src.length && !/[\s/>]/.test(src[i])) i++
  const name = src.slice(nameStart, i)
  if (!name) throw new Error('Empty element name')
  const attributes: Record<string, string> = {}
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (i >= src.length) throw new Error('Unterminated tag')
    if (src[i] === '>') return { name, attributes, selfClosing: false, next: i + 1 }
    if (src[i] === '/' && src[i + 1] === '>') return { name, attributes, selfClosing: true, next: i + 2 }
    const keyStart = i
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++
    const key = src.slice(keyStart, i)
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== '=') throw new Error(`Attribute ${key} has no value`)
    i++
    while (i < src.length && /\s/.test(src[i])) i++
    const quote = src[i]
    if (quote !== '"' && quote !== "'") throw new Error(`Attribute ${key} is not quoted`)
    const close = src.indexOf(quote, i + 1)
    if (close < 0) throw new Error('Unterminated attribute value')
    attributes[key] = decodeEntities(src.slice(i + 1, close))
    i = close + 1
  }
}
