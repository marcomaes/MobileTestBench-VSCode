// No Kotlin counterpart: replaces the JDK XPath engine (javax.xml.xpath) that LocatorQuery.findByXPath uses.
// A compact XPath 1.0 evaluator over a UiNode tree: every UiNode is an element named after its rawType whose
// attributes are the node's attributes (names that are not valid XML names are skipped, like the Kotlin code does);
// there are no text nodes. Only node-set results are accepted, as in the Kotlin code.
import type { UiNode } from './uiNode'

export class XPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XPathError'
  }
}

interface XNode {
  readonly kind: 'document' | 'element' | 'attribute'
  readonly name: string
  readonly value: string
  parent?: XNode
  readonly children: XNode[]
  readonly attributes: XNode[]
  order: number
  /** Order of the last node in this node's subtree (attributes included). */
  end: number
  readonly ui?: UiNode
}

type Value = number | string | boolean | XNode[]

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/

function buildDocument(root: UiNode): XNode {
  let counter = 0
  const doc: XNode = { kind: 'document', name: '', value: '', children: [], attributes: [], order: counter++, end: 0 }
  const make = (ui: UiNode, parent: XNode): XNode => {
    const el: XNode = { kind: 'element', name: ui.rawType, value: '', parent, children: [], attributes: [], order: counter++, end: 0, ui }
    for (const [name, value] of Object.entries(ui.attributes)) {
      if (!XML_NAME.test(name)) continue
      el.attributes.push({ kind: 'attribute', name, value, parent: el, children: [], attributes: [], order: counter++, end: 0 })
    }
    for (const child of ui.children) el.children.push(make(child, el))
    el.end = counter - 1
    return el
  }
  doc.children.push(make(root, doc))
  doc.end = counter - 1
  return doc
}

// ---- lexer

type Token = { type: 'num'; num: number } | { type: 'str'; text: string } | { type: 'name'; text: string } | { type: 'op'; text: string } | { type: 'sym'; text: string }

const isNameStart = (c: string | undefined): boolean => c !== undefined && /[\p{L}_]/u.test(c)
const isNameChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{Nd}._-]/u.test(c)

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const operatorExpected = (): boolean => {
    const prev = tokens[tokens.length - 1]
    if (!prev) return false
    if (prev.type === 'op') return false
    if (prev.type === 'sym' && ['@', '::', '(', '[', ','].includes(prev.text)) return false
    return true
  }
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end < 0) throw new XPathError('Unterminated string literal in XPath')
      tokens.push({ type: 'str', text: src.slice(i + 1, end) })
      i = end + 1
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)/.exec(src.slice(i))!
      tokens.push({ type: 'num', num: parseFloat(m[0]) })
      i += m[0].length
    } else if (c === '.' && src[i + 1] === '.') {
      tokens.push({ type: 'sym', text: '..' })
      i += 2
    } else if (c === '/' && src[i + 1] === '/') {
      tokens.push({ type: 'op', text: '//' })
      i += 2
    } else if (c === ':' && src[i + 1] === ':') {
      tokens.push({ type: 'sym', text: '::' })
      i += 2
    } else if (c === '!' && src[i + 1] === '=') {
      tokens.push({ type: 'op', text: '!=' })
      i += 2
    } else if ((c === '<' || c === '>') && src[i + 1] === '=') {
      tokens.push({ type: 'op', text: c + '=' })
      i += 2
    } else if ('/|+-=<>'.includes(c)) {
      tokens.push({ type: 'op', text: c })
      i++
    } else if ('()[].,@'.includes(c)) {
      tokens.push({ type: 'sym', text: c })
      i++
    } else if (c === '*') {
      tokens.push(operatorExpected() ? { type: 'op', text: '*' } : { type: 'name', text: '*' })
      i++
    } else if (isNameStart(c)) {
      let j = i + 1
      while (isNameChar(src[j])) j++
      // prefix:local or prefix:* (but not the axis separator ::)
      if (src[j] === ':' && src[j + 1] !== ':') {
        if (src[j + 1] === '*') j += 2
        else if (isNameStart(src[j + 1])) {
          j++
          while (isNameChar(src[j])) j++
        }
      }
      const text = src.slice(i, j)
      tokens.push(operatorExpected() && ['and', 'or', 'mod', 'div'].includes(text) ? { type: 'op', text } : { type: 'name', text })
      i = j
    } else {
      throw new XPathError(`Unexpected character '${c}' in XPath`)
    }
  }
  return tokens
}

// ---- conversions

const sortDedupe = (nodes: XNode[]): XNode[] => {
  const seen = new Set<XNode>()
  const out: XNode[] = []
  for (const n of nodes) if (!seen.has(n)) { seen.add(n); out.push(n) }
  return out.sort((a, b) => a.order - b.order)
}

const numToStr = (n: number): string => {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (n === 0) return '0'
  const s = String(n)
  if (!/e/i.test(s)) return s
  return Number.isInteger(n) ? BigInt(n).toString() : n.toFixed(20).replace(/0+$/, '')
}
const strValue = (n: XNode): string => (n.kind === 'attribute' ? n.value : '')
const toStr = (v: Value): string => (Array.isArray(v) ? (v.length ? strValue(v[0]) : '') : typeof v === 'number' ? numToStr(v) : typeof v === 'boolean' ? String(v) : v)
const strToNum = (s: string): number => (/^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(s) ? parseFloat(s) : NaN)
const toNum = (v: Value): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : strToNum(toStr(v)))
const toBool = (v: Value): boolean => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : typeof v === 'string' ? v.length > 0 : v)
const toNodes = (v: Value): XNode[] => {
  if (!Array.isArray(v)) throw new XPathError('Expression does not evaluate to a node-set')
  return v
}

const cmp = (op: string, a: string | number | boolean, b: string | number | boolean, relationalNumbers: boolean): boolean => {
  if (op === '=' || op === '!=') {
    let eq: boolean
    if (typeof a === 'boolean' || typeof b === 'boolean') eq = toBool(a) === toBool(b)
    else if (typeof a === 'number' || typeof b === 'number') eq = toNum(a) === toNum(b)
    else eq = a === b
    return op === '=' ? eq : !eq
  }
  void relationalNumbers
  const x = toNum(a)
  const y = toNum(b)
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y
}

function compare(op: string, a: Value, b: Value): boolean {
  const an = Array.isArray(a)
  const bn = Array.isArray(b)
  if (an && bn) {
    return (a as XNode[]).some((x) => (b as XNode[]).some((y) => cmp(op, op === '=' || op === '!=' ? strValue(x) : strToNum(strValue(x)), op === '=' || op === '!=' ? strValue(y) : strToNum(strValue(y)), true)))
  }
  if (an || bn) {
    const nodes = (an ? a : b) as XNode[]
    const other = (an ? b : a) as number | string | boolean
    if (typeof other === 'boolean') return an ? cmp(op, toBool(nodes), other, true) : cmp(op, other, toBool(nodes), true)
    return nodes.some((n) => {
      const mine: string | number = typeof other === 'number' || (op !== '=' && op !== '!=') ? strToNum(strValue(n)) : strValue(n)
      return an ? cmp(op, mine, other, true) : cmp(op, other, mine, true)
    })
  }
  return cmp(op, a as string | number | boolean, b as string | number | boolean, true)
}

// ---- evaluation

interface Ctx {
  readonly node: XNode
  readonly position: number
  readonly size: number
}
type Expr = (ctx: Ctx) => Value

const descendants = (n: XNode, out: XNode[] = []): XNode[] => {
  for (const c of n.children) {
    out.push(c)
    descendants(c, out)
  }
  return out
}

const documentOf = (n: XNode): XNode => {
  let d = n
  while (d.parent) d = d.parent
  return d
}

/** Nodes of the axis in axis order (reverse axes: nearest first). */
function axisNodes(axis: string, n: XNode): XNode[] {
  switch (axis) {
    case 'child':
      return [...n.children]
    case 'descendant':
      return descendants(n)
    case 'descendant-or-self':
      return [n, ...descendants(n)]
    case 'self':
      return [n]
    case 'parent':
      return n.parent ? [n.parent] : []
    case 'ancestor':
    case 'ancestor-or-self': {
      const out: XNode[] = axis === 'ancestor-or-self' ? [n] : []
      for (let p = n.parent; p; p = p.parent) out.push(p)
      return out
    }
    case 'attribute':
      return [...n.attributes]
    case 'following-sibling':
    case 'preceding-sibling': {
      if (n.kind === 'attribute' || !n.parent) return []
      const sibs = n.parent.children
      const at = sibs.indexOf(n)
      return axis === 'following-sibling' ? sibs.slice(at + 1) : sibs.slice(0, at).reverse()
    }
    case 'following': {
      const limit = n.kind === 'attribute' ? n.order : n.end
      return descendants(documentOf(n)).filter((e) => e.order > limit)
    }
    case 'preceding': {
      const ancestors = new Set<XNode>()
      for (let p = n.parent; p; p = p.parent) ancestors.add(p)
      return descendants(documentOf(n))
        .filter((e) => e.order < n.order && !ancestors.has(e))
        .reverse()
    }
    case 'namespace':
      return []
    default:
      throw new XPathError(`Unknown axis '${axis}'`)
  }
}

const nodeTypes = new Set(['node', 'text', 'comment', 'processing-instruction'])

function applyPredicates(nodes: XNode[], predicates: Expr[]): XNode[] {
  let current = nodes
  for (const p of predicates) {
    const size = current.length
    current = current.filter((node, i) => {
      const v = p({ node, position: i + 1, size })
      return typeof v === 'number' ? v === i + 1 : toBool(v)
    })
  }
  return current
}

interface Step {
  axis: string
  test: (n: XNode) => boolean
  predicates: Expr[]
}

function evalStep(step: Step, input: XNode[]): XNode[] {
  const out: XNode[] = []
  for (const n of input) {
    const candidates = axisNodes(step.axis, n).filter(step.test)
    out.push(...applyPredicates(candidates, step.predicates))
  }
  return sortDedupe(out)
}

const FUNCTIONS: Record<string, (ctx: Ctx, args: Value[]) => Value> = {
  last: (ctx) => ctx.size,
  position: (ctx) => ctx.position,
  count: (_c, [a]) => toNodes(a).length,
  id: () => [],
  'local-name': (ctx, a) => nameOf(ctx, a),
  name: (ctx, a) => nameOf(ctx, a),
  'namespace-uri': () => '',
  string: (ctx, a) => (a.length ? toStr(a[0]) : strValue(ctx.node)),
  concat: (_c, a) => a.map(toStr).join(''),
  'starts-with': (_c, [a, b]) => toStr(a).startsWith(toStr(b)),
  contains: (_c, [a, b]) => toStr(a).includes(toStr(b)),
  'substring-before': (_c, [a, b]) => {
    const s = toStr(a)
    const at = s.indexOf(toStr(b))
    return at < 0 ? '' : s.slice(0, at)
  },
  'substring-after': (_c, [a, b]) => {
    const s = toStr(a)
    const t = toStr(b)
    const at = s.indexOf(t)
    return at < 0 ? '' : s.slice(at + t.length)
  },
  substring: (_c, a) => {
    const chars = [...toStr(a[0])]
    const start = Math.round(toNum(a[1]))
    const end = a.length > 2 ? start + Math.round(toNum(a[2])) : Infinity
    if (Number.isNaN(start) || Number.isNaN(end)) return ''
    return chars.filter((_ch, i) => i + 1 >= start && i + 1 < end).join('')
  },
  'string-length': (ctx, a) => [...(a.length ? toStr(a[0]) : strValue(ctx.node))].length,
  'normalize-space': (ctx, a) => (a.length ? toStr(a[0]) : strValue(ctx.node)).trim().replace(/\s+/g, ' '),
  translate: (_c, [a, b, c]) => {
    const from = [...toStr(b)]
    const to = [...toStr(c)]
    return [...toStr(a)]
      .map((ch) => {
        const at = from.indexOf(ch)
        return at < 0 ? ch : (to[at] ?? '')
      })
      .join('')
  },
  boolean: (_c, [a]) => toBool(a),
  not: (_c, [a]) => !toBool(a),
  true: () => true,
  false: () => false,
  lang: () => false,
  number: (ctx, a) => (a.length ? toNum(a[0]) : strToNum(strValue(ctx.node))),
  sum: (_c, [a]) => toNodes(a).reduce((s, n) => s + strToNum(strValue(n)), 0),
  floor: (_c, [a]) => Math.floor(toNum(a)),
  ceiling: (_c, [a]) => Math.ceil(toNum(a)),
  round: (_c, [a]) => {
    const n = toNum(a)
    return Number.isFinite(n) ? Math.floor(n + 0.5) : n
  },
}
const ARITY: Record<string, [number, number]> = {
  last: [0, 0], position: [0, 0], count: [1, 1], id: [1, 1], 'local-name': [0, 1], name: [0, 1], 'namespace-uri': [0, 1], string: [0, 1],
  concat: [2, Infinity], 'starts-with': [2, 2], contains: [2, 2], 'substring-before': [2, 2], 'substring-after': [2, 2], substring: [2, 3],
  'string-length': [0, 1], 'normalize-space': [0, 1], translate: [3, 3], boolean: [1, 1], not: [1, 1], true: [0, 0], false: [0, 0], lang: [1, 1],
  number: [0, 1], sum: [1, 1], floor: [1, 1], ceiling: [1, 1], round: [1, 1],
}

function nameOf(ctx: Ctx, args: Value[]): string {
  const node = args.length ? toNodes(args[0])[0] : ctx.node
  return node && node.kind !== 'document' ? node.name : ''
}

// ---- parser

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const e = this.orExpr()
    if (this.pos < this.tokens.length) throw new XPathError(`Unexpected '${this.describe(this.tokens[this.pos])}' in XPath`)
    return e
  }

  private describe(t: Token): string {
    return t.type === 'num' ? String(t.num) : t.text
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }
  private isOp(text: string): boolean {
    const t = this.peek()
    return t?.type === 'op' && t.text === text
  }
  private isSym(text: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t?.type === 'sym' && t.text === text
  }
  private expectSym(text: string): void {
    if (!this.isSym(text)) throw new XPathError(`Expected '${text}' in XPath`)
    this.pos++
  }

  private orExpr(): Expr {
    let left = this.andExpr()
    while (this.isOp('or')) {
      this.pos++
      const l = left
      const r = this.andExpr()
      left = (c) => toBool(l(c)) || toBool(r(c))
    }
    return left
  }
  private andExpr(): Expr {
    let left = this.equalityExpr()
    while (this.isOp('and')) {
      this.pos++
      const l = left
      const r = this.equalityExpr()
      left = (c) => toBool(l(c)) && toBool(r(c))
    }
    return left
  }
  private equalityExpr(): Expr {
    let left = this.relationalExpr()
    while (this.isOp('=') || this.isOp('!=')) {
      const op = (this.peek() as { text: string }).text
      this.pos++
      const l = left
      const r = this.relationalExpr()
      left = (c) => compare(op, l(c), r(c))
    }
    return left
  }
  private relationalExpr(): Expr {
    let left = this.additiveExpr()
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = (this.peek() as { text: string }).text
      this.pos++
      const l = left
      const r = this.additiveExpr()
      left = (c) => compare(op, l(c), r(c))
    }
    return left
  }
  private additiveExpr(): Expr {
    let left = this.multiplicativeExpr()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.peek() as { text: string }).text
      this.pos++
      const l = left
      const r = this.multiplicativeExpr()
      left = op === '+' ? (c) => toNum(l(c)) + toNum(r(c)) : (c) => toNum(l(c)) - toNum(r(c))
    }
    return left
  }
  private multiplicativeExpr(): Expr {
    let left = this.unaryExpr()
    while (this.isOp('*') || this.isOp('div') || this.isOp('mod')) {
      const op = (this.peek() as { text: string }).text
      this.pos++
      const l = left
      const r = this.unaryExpr()
      left = op === '*' ? (c) => toNum(l(c)) * toNum(r(c)) : op === 'div' ? (c) => toNum(l(c)) / toNum(r(c)) : (c) => toNum(l(c)) % toNum(r(c))
    }
    return left
  }
  private unaryExpr(): Expr {
    if (this.isOp('-')) {
      this.pos++
      const e = this.unaryExpr()
      return (c) => -toNum(e(c))
    }
    return this.unionExpr()
  }
  private unionExpr(): Expr {
    let left = this.pathExpr()
    while (this.isOp('|')) {
      this.pos++
      const l = left
      const r = this.pathExpr()
      left = (c) => sortDedupe([...toNodes(l(c)), ...toNodes(r(c))])
    }
    return left
  }

  private startsFilterExpr(): boolean {
    const t = this.peek()
    if (!t) return false
    if (t.type === 'num' || t.type === 'str') return true
    if (t.type === 'sym' && t.text === '(') return true
    return t.type === 'name' && this.isSym('(', 1) && !nodeTypes.has(t.text)
  }

  private pathExpr(): Expr {
    if (this.startsFilterExpr()) {
      let primary = this.primary()
      const predicates = this.predicates()
      if (predicates.length) {
        const base = primary
        primary = (c) => applyPredicates(toNodes(base(c)), predicates)
      }
      if (this.isOp('/') || this.isOp('//')) {
        const steps = this.relativeSteps(true)
        const base = primary
        return (c) => steps.reduce((nodes, s) => evalStep(s, nodes), toNodes(base(c)))
      }
      return primary
    }
    return this.locationPath()
  }

  private primary(): Expr {
    const t = this.peek()!
    if (t.type === 'num') {
      this.pos++
      const n = t.num
      return () => n
    }
    if (t.type === 'str') {
      this.pos++
      const s = t.text
      return () => s
    }
    if (this.isSym('(')) {
      this.pos++
      const e = this.orExpr()
      this.expectSym(')')
      return e
    }
    // function call
    const name = (t as { text: string }).text
    this.pos += 2
    const args: Expr[] = []
    if (!this.isSym(')')) {
      args.push(this.orExpr())
      while (this.isSym(',')) {
        this.pos++
        args.push(this.orExpr())
      }
    }
    this.expectSym(')')
    const fn = FUNCTIONS[name]
    const arity = ARITY[name]
    if (!fn || !arity) throw new XPathError(`Could not find function: ${name}`)
    if (args.length < arity[0] || args.length > arity[1]) throw new XPathError(`Wrong number of arguments to ${name}()`)
    return (c) => fn(c, args.map((a) => a(c)))
  }

  private predicates(): Expr[] {
    const out: Expr[] = []
    while (this.isSym('[')) {
      this.pos++
      out.push(this.orExpr())
      this.expectSym(']')
    }
    return out
  }

  private locationPath(): Expr {
    if (this.isOp('/')) {
      this.pos++
      const t = this.peek()
      const hasSteps = t !== undefined && (t.type === 'name' || (t.type === 'sym' && ['.', '..', '@'].includes(t.text)))
      const steps = hasSteps ? this.stepList() : []
      return (c) => steps.reduce((nodes, s) => evalStep(s, nodes), [documentOf(c.node)])
    }
    if (this.isOp('//')) {
      this.pos++
      const steps = [descendantOrSelf(), ...this.stepList()]
      return (c) => steps.reduce((nodes, s) => evalStep(s, nodes), [documentOf(c.node)])
    }
    const steps = this.stepList()
    return (c) => steps.reduce((nodes, s) => evalStep(s, nodes), [c.node])
  }

  /** step (('/' | '//') step)* */
  private stepList(): Step[] {
    const steps: Step[] = [this.step()]
    while (this.isOp('/') || this.isOp('//')) {
      if (this.isOp('//')) steps.push(descendantOrSelf())
      this.pos++
      steps.push(this.step())
    }
    return steps
  }

  /** After a filter expression: ('/' | '//') step ... */
  private relativeSteps(_afterFilter: boolean): Step[] {
    const steps: Step[] = []
    while (this.isOp('/') || this.isOp('//')) {
      if (this.isOp('//')) steps.push(descendantOrSelf())
      this.pos++
      steps.push(this.step())
    }
    return steps
  }

  private step(): Step {
    if (this.isSym('.')) {
      this.pos++
      return { axis: 'self', test: () => true, predicates: [] }
    }
    if (this.isSym('..')) {
      this.pos++
      return { axis: 'parent', test: () => true, predicates: [] }
    }
    let axis = 'child'
    if (this.isSym('@')) {
      this.pos++
      axis = 'attribute'
    } else {
      const t = this.peek()
      if (t?.type === 'name' && this.isSym('::', 1)) {
        axis = t.text
        this.pos += 2
      }
    }
    const t = this.peek()
    if (!t || t.type !== 'name') throw new XPathError('Expected a node test in XPath')
    this.pos++
    let test: (n: XNode) => boolean
    if (this.isSym('(') && nodeTypes.has(t.text)) {
      this.pos++
      if (t.text === 'processing-instruction' && this.peek()?.type === 'str') this.pos++
      this.expectSym(')')
      test = t.text === 'node' ? () => true : () => false
    } else {
      const principal = axis === 'attribute' ? 'attribute' : 'element'
      const name = t.text
      if (name === '*') test = (n) => n.kind === principal
      else if (name.endsWith(':*')) test = () => false // no namespaces in the tree
      else test = (n) => n.kind === principal && n.name === name
    }
    return { axis, test, predicates: this.predicates() }
  }
}

const descendantOrSelf = (): Step => ({ axis: 'descendant-or-self', test: () => true, predicates: [] })

/** Evaluates [expression] against the tree under [root]; the result must be a node-set. Throws XPathError. */
export function evaluateXPath(expression: string, root: UiNode): UiNode[] {
  const expr = new Parser(tokenize(expression)).parse()
  const doc = buildDocument(root)
  const result = toNodes(expr({ node: doc, position: 1, size: 1 }))
  return sortDedupe(result)
    .filter((n) => n.kind === 'element' && n.ui !== undefined)
    .map((n) => n.ui!)
}
