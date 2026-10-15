# Mobile Test Bench for VS Code

Mirror and control Android and iOS devices in VS Code, inspect their UI, and get ready-to-use **Mobilewright**, **Appium** and **WebdriverIO** locators. This is the VS Code port of the [Mobile Test Bench IntelliJ plugin](https://github.com/marcomaes/MobileTestBench).

## Features

- **Mirror and control**: Android emulators and phones, iOS simulators and iPhones. Click to tap, drag to swipe, hold for a long press, type with the keyboard.
- **Inspector**: element tree, properties, highlight on the screen, locator suggestions with duplicate detection, scoped locators, accessibility audit, page object generator.
- **Recorder and player**: record gestures, add assertions, replay, copy or insert as Mobilewright, Appium or WebdriverIO code.
- **Show Locator on Device**: caret on a locator in your test code, `Ctrl+Alt+Shift+M`, highlights the matches on the device.
- **Device Tools** tabs: Log, Apps (reset state, permissions), Open URL, Crashes, Location, Display and language, Input, Network, Battery, Biometrics, WebView, Files, Performance, Visual diff, Notifications.
- **Device power and reconnect**: boot, shut down, reboot; reconnect automatically after a drop.

## Requirements

- `mobilecli` (`npm install -g mobilecli`): iOS, the Android 17 inspector and many tools.
- `adb` from the Android SDK platform-tools for Android.
- macOS with Xcode (`simctl`) for iOS simulators.

Setup per platform: [docs/DEVICE-SETUP.md](https://github.com/marcomaes/MobileTestBench/blob/main/docs/DEVICE-SETUP.md).

## Privacy

No telemetry. The extension talks to your devices through adb, xcrun and mobilecli, to the local emulator gRPC port, and to a WebDriverAgent URL you configure. See [PRIVACY.md](PRIVACY.md).

## Thank you

A big thank you to [Gil Megidish](https://www.linkedin.com/in/gilmegidish/), CEO of [Mobile-Next](https://github.com/mobile-next), who created [mobilecli](https://github.com/mobile-next/mobilecli) and [Mobilewright](https://github.com/mobile-next/mobilewright). Mirroring and controlling iPhones and simulators, reading the UI hierarchy on Android 17, and many of the Device Tools tabs run on mobilecli, and the locators follow Mobilewright's Inspector rules. Without his work, this extension would not be possible.

## Development

```bash
npm install
npm run build && npm test
```

Press F5 to start an Extension Development Host. See `docs/PORTING.md` and `docs/SYNC.md`.

### Staying in step with the IntelliJ plugin

`npm run sync:check` reports which Kotlin files changed since they were ported, `npm run sync:fixtures` shares the plugin's test fixtures, and `docs/PARITY.md` lists every Kotlin file with its TypeScript counterpart. Details in `docs/SYNC.md`.

## Status

Ported from plugin version 1.0.1. The host and webview code has been type checked and bundled but not yet run in a real VS Code window; the pure core has 769 unit tests ported from the plugin. Expect UI rough edges until it has been exercised against real devices.

## License

Copyright 2026 Marco Maes. Licensed under the Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
