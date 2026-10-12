import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A fixture shared with the IntelliJ plugin (copied by `npm run sync:fixtures`). */
export const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')
export const fixtureBytes = (name: string): Buffer => readFileSync(join(__dirname, '..', 'fixtures', name))
