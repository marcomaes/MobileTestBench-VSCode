# Device setup

How to prepare each kind of device. Back to the [README](../README.md).

Open the **Mobile Devices** view in the activity bar, pick a device and open it. Use **Refresh Devices** after you start or connect one.

## Android

* Start an emulator (Device Manager or `emulator -avd <name>`) or connect a device.
* adb is found via the `mobileTestBench.adbPath` setting, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` or `PATH`.
* The gRPC port and token are read from the emulator discovery files (`~/Library/Caches/TemporaryItems/avd/running/pid_*.ini` on macOS), the same mechanism Android Studio uses. Turn this off with `mobileTestBench.useEmulatorGrpc`; the extension then uses adb.

## iOS simulator

* Boot a simulator.
* With [mobilecli](https://github.com/mobile-next/mobilecli) installed (`npm install -g mobilecli`) the simulator works like an iOS device: screen, input and inspection go through mobilecli, no WDA needed.
* Without mobilecli, input and inspection need **WebDriverAgent** running on that simulator. Two ways to start it:
  * Start an Appium XCUITest session once; Appium keeps WDA running on port 8100, with MJPEG on 9100.
  * Or build and run WDA directly:

    ```bash
    xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
      -destination "platform=iOS Simulator,id=<udid>" test
    ```
* Without mobilecli and WDA you still get the screen (simctl screenshots) but no input or hierarchy.
* The WDA URLs (only used without mobilecli) are the settings `mobileTestBench.wdaUrl` and `mobileTestBench.mjpegUrl`.

## iOS device (physical, via mobilecli)

* Install [mobilecli](https://github.com/mobile-next/mobilecli) (`npm install -g mobilecli`). It is found on the `PATH` of VS Code, then `/opt/homebrew/bin` and `/usr/local/bin`. Without it physical devices are simply not listed.
* Connect and trust the device; it then shows up as `[physical]`. Devices are listed with `mobilecli devices --platform ios --type real`.
* Input and inspection use mobilecli's on-device agent. For a real device it may need installing first (`mobilecli agent install --device <id> --provisioning-profile <file>`, see `mobilecli agent install --help`). The extension does not do this for you, but when mobilecli reports `agent is not installed` the status line shows the full setup (command with your device id, matching development provisioning profile, Developer Mode, trusting the certificate).
* Only Home, volume, Enter and Backspace are available as keys; Back, Recent Apps and Power are not.
