// How the desktop app starts and stops: at login, when its main window closes, and when the
// computer is idle.

/**
 * Where agents browse the web. `app`: the Builders Bot browser. `playwright-legacy`: the person's
 * Chrome through the Playwright extension and the shared Playwright server. `chrome`: the person's
 * Chrome through the Builders Bot extension; until the bridge ships, it browses as `playwright-legacy`.
 */
export const WEB_ACCESS_MODES = ["app", "chrome", "playwright-legacy"] as const;
export type WebAccessMode = (typeof WEB_ACCESS_MODES)[number];

/**
 * `browserInApp` is the released switch, and an older app reads only it. The app keeps writing it, as
 * `webAccess === "app"`, so a downgrade keeps the choice. A file or a payload with no `webAccess` reads
 * from the switch: on is `app`, off is `playwright-legacy`.
 */
export function webAccessFromSwitch(browserInApp: boolean): WebAccessMode {
  return browserInApp ? "app" : "playwright-legacy";
}

/** As it crosses IPC. Null marks a choice that this run of the app does not offer. */
export interface AppBehaviorPreference {
  /** Open Builders Bot when the user signs in. Null in a development run and on a server. */
  launchAtLogin: boolean | null;
  /**
   * Hide the main window on close and show a tray icon, rather than quit. Null on macOS, where
   * Builders Bot always keeps running after its window closes, and on a server.
   */
  keepRunningInBackground: boolean | null;
  /**
   * Stop the idle sleep of the computer while it is on its power adapter, so routines run on time.
   * Null on Linux, where Electron does not report a change of the power source, and on a server.
   */
  keepAwake: boolean | null;
  /** Keep the computer awake on battery power too. Null where `keepAwake` is null. */
  keepAwakeOnBattery: boolean | null;
  /**
   * Web access goes through the Builders Bot browser instead of Playwright in the person's own browser.
   * Off by default: Playwright attaches to the browser that is already open, so no second Chrome starts.
   */
  browserInApp: boolean;
  /** Where agents browse. `browserInApp` is always `webAccess === "app"`. */
  webAccess: WebAccessMode;
  /**
   * Builder Auto, Builder Code and Builder Fast declare the full window of the Cultura Builder gateway
   * (1,048,576 tokens). Off by default: every Cultura Builder model declares 262,144 tokens, so
   * OpenCode compacts a long session sooner and each step sends less.
   */
  culturaBuilderFullContext: boolean;
}

/** The choices to change. A choice that is not given keeps its value. */
export interface AppBehaviorPreferenceChange {
  launchAtLogin?: boolean;
  keepRunningInBackground?: boolean;
  keepAwake?: boolean;
  keepAwakeOnBattery?: boolean;
  /** The released switch. With `webAccess` in the same change, `webAccess` wins. */
  browserInApp?: boolean;
  webAccess?: WebAccessMode;
  culturaBuilderFullContext?: boolean;
}
