import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')

const common = { bundle: true, sourcemap: watch, logLevel: 'info', target: 'es2022' }

const host = {
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
}

const web = {
  ...common,
  entryPoints: { mirror: 'src/webview/mirror.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
}

mkdirSync('dist', { recursive: true })
cpSync('src/proto', 'dist/proto', { recursive: true })

if (watch) {
  for (const options of [host, web]) await (await esbuild.context(options)).watch()
} else {
  await Promise.all([esbuild.build(host), esbuild.build(web)])
}
