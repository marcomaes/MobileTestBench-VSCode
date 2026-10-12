// ported-from: test:core/HierarchyDumpTest.kt
import { describe, expect, it } from 'vitest'
import { HierarchyDump } from '../../src/core/hierarchyDump'
import { UiNode } from '../../src/core/inspector/uiNode'
import { rect } from '../../src/core/model'
import { parseXml } from '../../src/core/xml'

describe('HierarchyDumpTest', () => {
  it('sibling file swaps the extension', () => {
    expect(HierarchyDump.siblingFile('/tmp/a/shot-1.png')).toBe('/tmp/a/shot-1.xml')
    expect(HierarchyDump.siblingFile('/tmp/a/shot.v2.png')).toBe('/tmp/a/shot.v2.xml')
    expect(HierarchyDump.siblingFile('/tmp/a/shot')).toBe('/tmp/a/shot.xml')
  })

  it('xml is well formed, escaped and nested', () => {
    const root = new UiNode('ANDROID', 'hierarchy', {}, rect(0, 0, 100, 200))
    const child = new UiNode('ANDROID', 'android.widget.Button', { text: 'A & "B" <c>\nx', 'bad key': 'z' }, rect(1, 2, 3, 4))
    root.addChild(child)
    const xml = HierarchyDump.toXml(root)
    expect(xml).toContain('text="A &amp; &quot;B&quot; &lt;c&gt;&#10;x"')
    expect(xml).toContain('x="1" y="2" width="3" height="4"')
    expect(xml).not.toContain('bad key')
    const doc = parseXml(xml)
    const button = doc.children.find((it) => it.tagName === 'android.widget.Button')!
    expect(button.attributes.text).toBe('A & "B" <c>\nx')
  })

  it('invalid tag name falls back to node', () => {
    const root = new UiNode('IOS', '', {}, undefined)
    expect(HierarchyDump.toXml(root)).toContain('<node/>')
  })
})
