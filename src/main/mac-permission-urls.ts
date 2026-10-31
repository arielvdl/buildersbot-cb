// The System Settings panes macOS opens from a URL, kept out of the renderer.

import type { MacPermissionId } from "@openbot/contracts/ipc";

/**
 * The panes that this file has an address for: each permission Computer Use needs, and the
 * microphone that dictation needs. The microphone is not a `MacPermissionId`: that type is the
 * list that the Computer Use panel draws and checks, and Computer Use does not use the microphone.
 */
type MacSettingsPane = MacPermissionId | "microphone";

/**
 * Where macOS shows the grant for each permission.
 *
 * These addresses are a product contract the checker cannot judge: a wrong one sends a user who
 * asked for screen recording to some other pane, and the type only says "a string". They live here,
 * apart from the services that open them, because unrelated callers read the same URLs - the
 * Computer Use panel and the `mac-screen-recording` and `mac-microphone` external destinations.
 */
export const MAC_PERMISSION_URLS: Record<MacSettingsPane, string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
  microphone: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
};
