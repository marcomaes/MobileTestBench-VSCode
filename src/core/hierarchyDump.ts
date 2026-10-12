// ported-from: core/HierarchyDump.kt
import * as path from 'node:path'
import type { UiNode } from './inspector/uiNode'

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/
const isXmlName = (s: string): boolean => s.length > 0 && XML_NAME.test(s)
const tagName = (raw: string): string => (isXmlName(raw) ? raw : 'node')

function escape(s: string): string {
  let sb = ''
  for (const c of s) {
    if (c === '&') sb += '&amp;'
    else if (c === '<') sb += '&lt;'
    else if (c === '>') sb += '&gt;'
    else if (c === '"') sb += '&quot;'
    else if (c === '\n') sb += '&#10;'
    else if (c === '\r') sb += '&#13;'
    else if (c === '\t') sb += '&#9;'
    else if (c.charCodeAt(0) < 0x20) {
      // not allowed in XML 1.0
    } else sb += c
  }
  return sb
}

function write(node: UiNode, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth)
  let line = `${indent}<${tagName(node.rawType)}`
  // toSortedMap(): String keys in UTF-16 code unit order, which is the default JS sort.
  for (const key of Object.keys(node.attributes).sort()) {
    if (!isXmlName(key)) continue
    line += ` ${key}="${escape(node.attributes[key])}"`
  }
  const b = node.bounds
  if (b) line += ` x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}"`
  if (node.children.length === 0) {
    out.push(line + '/>\n')
  } else {
    out.push(line + '>\n')
    for (const child of node.children) write(child, depth + 1, out)
    out.push(`${indent}</${tagName(node.rawType)}>\n`)
  }
}

/** Saves the UI hierarchy as XML next to a screenshot: same base name, `.xml` extension. */
export const HierarchyDump = {
  /** The sidecar file for [image]: "a/b.png" gives "a/b.xml" (an image name without extension gets ".xml" appended). */
  siblingFile(image: string): string {
    const name = path.basename(image)
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    // java.io.File(null, name) is just the name; File(parent, name) keeps the parent.
    return image.includes(path.sep) ? path.join(path.dirname(image), `${base}.xml`) : `${base}.xml`
  },

  /** The tree as indented XML: one element per node, attributes as given by the device, bounds as x/y/width/height. */
  toXml(root: UiNode): string {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n']
    write(root, 0, out)
    return out.join('')
  },
}
