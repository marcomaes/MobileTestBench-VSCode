# Keeping the plugin and the extension in sync

The IntelliJ plugin (`../../MobileTestBench`) is the source of truth for behaviour. The extension is a port, so the two can only be kept in step by tooling that tells you what changed on the Kotlin side and what the TypeScript side has not absorbed yet. Nothing here modifies the plugin.

## The mechanism

1. **Header links.** Every ported TypeScript file starts with `// ported-from: core/x/Y.kt`. That line is the only link between the two code bases, so it cannot go stale in a separate table.
2. **Recorded hashes.** `sync/manifest.json` stores, per Kotlin file, the git blob hash and plugin commit at the moment someone confirmed the TypeScript matches.
3. **Check.** `npm run sync:check` hashes the current Kotlin files and reports:
   - `DRIFT`: the Kotlin file changed after it was ported.
   - `UNRECORDED`: ported, never recorded.
   - `MISSING`: Kotlin file with no counterpart (and not listed in `sync/not-ported.json`).
   - `ORPHAN`: a header points at a Kotlin file that no longer exists.
   Exit code 1 on drift, unrecorded or orphans; add `--strict` to fail on missing files too.
4. **Shared fixtures.** `npm run sync:fixtures` copies the plugin's `src/test/resources/fixtures` into `test/fixtures`. Both test suites then run against the same device output. `npm run sync:fixtures -- --check` only reports differences.
5. **Shared tests.** Kotlin tests are ported with `// ported-from: test:core/XTest.kt` headers, so a changed Kotlin test shows up as drift too. A new Kotlin test case is the signal to add the case on this side.

## Workflow after a plugin change

```bash
npm run sync:fixtures            # pick up new or changed fixtures
npm run sync:check               # which ported files drifted?
node scripts/sync.mjs diff       # git diff of each drifted Kotlin file since it was ported
# update the TypeScript (and its tests), then:
npm test
node scripts/sync.mjs update core/inspector/Locators.kt   # record: "the port matches"
npm run sync -- report           # refresh docs/PARITY.md
```

`update` takes Kotlin or TypeScript paths (suffix match) or `--all`. Record only what you reviewed: recording is the sign-off.

## Where the plugin is found

`sync/config.json`: `pluginDir` (default `../../MobileTestBench`, relative to this repository), overridable with the `MTB_PLUGIN_DIR` environment variable.

## Intentional differences

`sync/not-ported.json` lists Kotlin files that have no TypeScript counterpart and why (Swing settings page, IntelliJ tool window factory). Add to it instead of leaving a file `missing`.

## What this does not do

It detects change; it does not translate it. A drifted file needs a human (or an assistant) to read the diff and port it. Behaviour that only exists in UI code (Swing) is covered by the header link on the matching webview file, not by tests.

## CI

`.github/workflows/sync.yml` checks out both repositories and runs `sync:check` and `sync:fixtures -- --check` on a schedule and on every push, so drift cannot go unnoticed.
