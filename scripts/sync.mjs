#!/usr/bin/env node
// Keeps the VS Code extension in step with the IntelliJ plugin it is ported from.
//
// How it works
//   * Every ported TypeScript file starts with one or more header lines:   // ported-from: core/inspector/Locators.kt
//     (for a Kotlin test file: // ported-from: test:core/ParsersTest.kt).
//   * sync/manifest.json records, per Kotlin file, the git blob hash it had when it was last ported ("update").
//   * `check` compares the plugin checkout with the manifest and reports drift, missing ports and orphans.
//   * `fixtures` copies the plugin's test fixtures into test/fixtures, so both sides test against the same files.
//
// The plugin repository stays the source of truth and is never modified.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'sync/config.json'), 'utf8'))
const manifestPath = join(root, 'sync/manifest.json')
const notPortedPath = join(root, 'sync/not-ported.json')

const pluginDir = resolve(root, process.env[config.pluginDirEnv] ?? config.pluginDir)
const kotlinRoot = join(pluginDir, config.kotlinRoot)
const kotlinTestRoot = join(pluginDir, config.kotlinTestRoot)

const args = process.argv.slice(2)
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'check'
const rest = args.filter((a, i) => !(i === 0 && a === command))
const flag = (name) => rest.includes(`--${name}`)
const positional = rest.filter((a) => !a.startsWith('--'))

if (!existsSync(kotlinRoot)) {
  fail(`Plugin checkout not found at ${pluginDir}. Set ${config.pluginDirEnv} or edit sync/config.json.`)
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

/** Git blob hash, so it equals `git hash-object` in the plugin repository and needs no git to compute. */
function blobHash(file) {
  const content = readFileSync(file)
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

function walk(dir, extension, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'fixtures') continue
      walk(full, extension, out)
    } else if (name.endsWith(extension)) out.push(full)
  }
  return out
}

function git(...gitArgs) {
  try {
    return execFileSync('git', ['-C', pluginDir, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)

/** Kotlin key ("core/Model.kt" or "test:core/ParsersTest.kt") to absolute path. */
function kotlinPath(key) {
  return key.startsWith('test:') ? join(kotlinTestRoot, key.slice(5)) : join(kotlinRoot, key)
}

/** All Kotlin files in scope, as keys. */
function kotlinFiles() {
  const main = walk(kotlinRoot, '.kt').map((f) => relative(kotlinRoot, f).split(sep).join('/'))
  const tests = walk(kotlinTestRoot, '.kt').map((f) => 'test:' + relative(kotlinTestRoot, f).split(sep).join('/'))
  return [...main, ...tests].sort()
}

/** Ported TypeScript files: { kotlinKey -> [tsFile, ...] } read from the header comments. */
function scanPorts() {
  const ports = new Map()
  for (const dir of config.tsRoots) {
    for (const file of walk(join(root, dir), '.ts')) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (const line of lines) {
        const m = /^\/\/\s*ported-from:\s*(\S+)/.exec(line)
        if (m) {
          const list = ports.get(m[1]) ?? []
          list.push(relative(root, file).split(sep).join('/'))
          ports.set(m[1], list)
        } else if (!line.startsWith('//') && line.trim() !== '') break
      }
    }
  }
  return ports
}

function evaluate() {
  const manifest = readJson(manifestPath, { pluginCommit: '', ports: {} })
  const notPorted = readJson(notPortedPath, {})
  const ports = scanPorts()
  const kotlin = new Set(kotlinFiles())
  const rows = []
  for (const key of [...kotlin].sort()) {
    const ts = ports.get(key) ?? []
    const hash = blobHash(kotlinPath(key))
    const recorded = manifest.ports[key]
    let status
    if (ts.length === 0) status = notPorted[key] ? 'not-ported' : 'missing'
    else if (!recorded) status = 'unrecorded'
    else status = recorded.hash === hash ? 'in-sync' : 'drift'
    rows.push({ key, ts, status, hash, recorded, reason: notPorted[key] })
  }
  const orphans = [...ports].filter(([key]) => !kotlin.has(key))
  const stale = Object.keys(manifest.ports).filter((key) => !kotlin.has(key))
  return { manifest, rows, orphans, stale }
}

function printCheck({ rows, orphans, stale }) {
  const by = (status) => rows.filter((r) => r.status === status)
  const section = (title, list, line) => {
    if (!list.length) return
    console.log(`\n${title} (${list.length})`)
    for (const r of list) console.log('  ' + line(r))
  }
  section('DRIFT: Kotlin changed since it was ported', by('drift'), (r) => `${r.key}  ->  ${r.ts.join(', ')}`)
  section('UNRECORDED: ported but not yet recorded (run: npm run sync -- update)', by('unrecorded'), (r) => `${r.key}  ->  ${r.ts.join(', ')}`)
  section('MISSING: no TypeScript counterpart yet', by('missing'), (r) => r.key)
  section('ORPHAN: TypeScript points at a Kotlin file that does not exist', orphans, ([key, ts]) => `${key}  <-  ${ts.join(', ')}`)
  section('STALE: recorded in the manifest, Kotlin file is gone', stale.map((key) => ({ key })), (r) => r.key)
  const counts = ['in-sync', 'drift', 'unrecorded', 'missing', 'not-ported'].map((s) => `${by(s).length} ${s}`).join(', ')
  console.log(`\n${rows.length} Kotlin files: ${counts}`)
}

function recordedCommit() {
  return git('rev-parse', 'HEAD')
}

function update(selected) {
  const { manifest, rows } = evaluate()
  const targets = rows.filter((r) => r.ts.length > 0 && (selected.length === 0 || selected.some((s) => r.key === s || r.key.endsWith(s) || r.ts.includes(s))))
  if (selected.length === 0 && !flag('all')) {
    fail('Recording hashes says "I reviewed these Kotlin changes and the TypeScript matches". Pass the Kotlin or TypeScript files to record, or --all.')
  }
  const commit = recordedCommit()
  for (const r of targets) manifest.ports[r.key] = { hash: r.hash, commit, ts: r.ts }
  for (const key of Object.keys(manifest.ports)) if (!rows.some((r) => r.key === key)) delete manifest.ports[key]
  manifest.pluginCommit = commit
  manifest.updated = new Date().toISOString().slice(0, 10)
  writeFileSync(manifestPath, JSON.stringify(sortKeys(manifest), null, 2) + '\n')
  console.log(`Recorded ${targets.length} files at plugin commit ${commit.slice(0, 10)}.`)
}

function sortKeys(manifest) {
  return { ...manifest, ports: Object.fromEntries(Object.entries(manifest.ports).sort(([a], [b]) => a.localeCompare(b))) }
}

function showDiff(selected) {
  const { rows } = evaluate()
  const drifted = rows.filter((r) => r.status === 'drift' && (selected.length === 0 || selected.some((s) => r.key.endsWith(s))))
  if (!drifted.length) return console.log('No drift.')
  for (const r of drifted) {
    const base = r.recorded.commit
    console.log(`\n=== ${r.key} (ported at ${base.slice(0, 10)}) -> ${r.ts.join(', ')}`)
    const path = relative(pluginDir, kotlinPath(r.key))
    const out = base ? git('diff', '--no-color', base, '--', path) : ''
    console.log(out || '(no git history for the recorded commit; compare the files by hand)')
  }
}

function fixtures() {
  const source = join(pluginDir, config.fixturesDir)
  const target = join(root, config.localFixturesDir)
  if (!existsSync(source)) fail(`No fixtures at ${source}`)
  const changed = []
  const copyDir = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      const src = join(from, name)
      const dst = join(to, name)
      if (statSync(src).isDirectory()) copyDir(src, dst)
      else if (!existsSync(dst) || blobHash(src) !== blobHash(dst)) {
        changed.push(relative(target, dst))
        if (!flag('check')) cpSync(src, dst)
      }
    }
  }
  copyDir(source, target)
  if (flag('check')) {
    if (changed.length) {
      console.log(`${changed.length} fixtures differ from the plugin (run: npm run sync:fixtures):`)
      changed.slice(0, 40).forEach((f) => console.log('  ' + f))
      process.exit(1)
    }
    return console.log('Fixtures are identical to the plugin.')
  }
  console.log(changed.length ? `Copied ${changed.length} changed fixtures.` : 'Fixtures already identical.')
}

function report() {
  const { rows } = evaluate()
  const icon = { 'in-sync': 'in sync', drift: 'DRIFT', unrecorded: 'unrecorded', missing: 'missing', 'not-ported': 'not ported' }
  const lines = [
    '# Port status',
    '',
    'Generated by `npm run sync -- report`. Do not edit by hand.',
    '',
    '| Kotlin (plugin) | TypeScript (extension) | Status |',
    '|---|---|---|',
    ...rows.map((r) => `| \`${r.key}\` | ${r.ts.length ? r.ts.map((t) => `\`${t}\``).join(', ') : r.reason ?? ''} | ${icon[r.status]} |`),
    '',
  ]
  writeFileSync(join(root, 'docs/PARITY.md'), lines.join('\n'))
  const counts = Object.entries(Object.groupBy(rows, (r) => r.status)).map(([k, v]) => `${v.length} ${k}`).join(', ')
  console.log(`docs/PARITY.md written (${counts}).`)
}

switch (command) {
  case 'check': {
    const result = evaluate()
    printCheck(result)
    const bad = result.rows.filter((r) => r.status === 'drift' || r.status === 'unrecorded').length + result.orphans.length
    const missing = result.rows.filter((r) => r.status === 'missing').length
    if (bad > 0 || (flag('strict') && missing > 0)) process.exit(1)
    break
  }
  case 'update':
    update(positional)
    break
  case 'diff':
    showDiff(positional)
    break
  case 'fixtures':
    fixtures()
    break
  case 'report':
    report()
    break
  default:
    fail('Usage: node scripts/sync.mjs [check [--strict] | update <files...|--all> | diff [file] | fixtures [--check] | report]')
}
