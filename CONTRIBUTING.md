# Contributing

This extension is the VS Code port of the [Mobile Test Bench IntelliJ plugin](https://github.com/marcomaes/MobileTestBench).

## Development

```bash
npm install
npm run build && npm test
```

Press F5 to start an Extension Development Host. See `docs/PORTING.md` and `docs/SYNC.md`.

## Staying in step with the IntelliJ plugin

`npm run sync:check` reports which Kotlin files changed since they were ported, `npm run sync:fixtures` shares the plugin's test fixtures, and `docs/PARITY.md` lists every Kotlin file with its TypeScript counterpart. Details in `docs/SYNC.md`.

## Status

Ported from plugin version 1.0.1. The pure core has unit tests ported from the plugin, and the extension has been tested on Android emulators and devices and iOS simulators and iPhones.
