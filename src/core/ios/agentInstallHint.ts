// ported-from: core/ios/AgentInstallHint.kt

const MARKER = 'agent is not installed'

/**
 * A physical iPhone needs mobilecli's on-device agent before screenshots or input work. mobilecli's own error names the
 * command with an empty profile; this replaces it with the whole setup. Other messages pass through unchanged.
 */
export const AgentInstallHint = {
  rewrite: (message: string, deviceId: string): string => (message.includes(MARKER) ? AgentInstallHint.text(deviceId) : message),

  text: (deviceId: string): string =>
    'The mobilecli agent is not installed on this iPhone. Install it: ' +
    `mobilecli agent install --device ${deviceId} --provisioning-profile <file.mobileprovision> ` +
    "(see mobilecli agent install --help for the agent's bundle id and signing options). " +
    "The profile must be a development profile that matches the agent's bundle id and includes this iPhone's UDID. " +
    'Developer Mode must be on (Settings > Privacy & Security) and the iPhone unlocked and trusted. ' +
    'After the install, trust the developer certificate (Settings > General > VPN & Device Management), then reconnect the device.',
}
