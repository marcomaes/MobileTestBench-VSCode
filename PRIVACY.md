# Privacy

Last updated: 2026-10-15

Mobile Test Bench is a VS Code extension. It does not collect, store on a server or transmit personal data, usage statistics, crash reports or telemetry. The author receives no data from your use of the extension.

## What the extension does with your data

- **Devices.** The extension talks to your Android emulators and devices, and your iOS simulators and iPhones, through the command line tools `adb`, `xcrun` (`simctl`) and `mobilecli`. Screenshots, the UI hierarchy, logs, files and other data from a device stay on your machine and are shown in VS Code.
- **Local connections.** The extension connects to the gRPC port of a local Android emulator. It connects to a WebDriverAgent URL only when you configure one in the settings. That URL is normally on your own machine or network.
- **Settings and project state.** Your settings, such as saved places, notification payload history, baseline screenshots and the last used device, are stored locally by VS Code in its own global and workspace storage. The extension does not send them anywhere.

## Third-party tools

`adb`, Xcode (`xcrun`, `simctl`) and `mobilecli` are separate tools with their own behaviour and privacy terms. The extension only runs them on your machine. Apps you inspect or test may send data of their own. The extension does not control that.

## Changes

If this changes, for example if the extension ever adds telemetry, this page will be updated and the change will be listed in the [changelog](CHANGELOG.md). Any data collection would need your explicit permission first.

## Contact

Questions: [github.com/marcomaes/MobileTestBench/issues](https://github.com/marcomaes/MobileTestBench/issues).
