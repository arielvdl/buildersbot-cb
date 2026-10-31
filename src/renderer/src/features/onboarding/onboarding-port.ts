import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What onboarding reaches in main: the saved setup, the preview of an invite before the user
 * joins, and the browser for the Terms of Service and the Privacy Policy.
 */
export interface OnboardingPort {
  getSetupState: BuildersBotDesktopApi["getSetupState"];
  saveSetup: BuildersBotDesktopApi["saveSetup"];
  onSetupState: BuildersBotDesktopApi["onSetupState"];
  servers: Pick<BuildersBotDesktopApi["servers"], "previewInvite">;
  openUrl: BuildersBotDesktopApi["openUrl"];
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function onboardingPort(): OnboardingPort {
  return window.openbot;
}
