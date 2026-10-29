import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

/**
 * What makes one installation of the web app itself, not the browser tab it happens to run in.
 *
 * Two installs of the app on one phone, or the app on a phone and the same account in a browser tab,
 * are different clients: each has its own account session, its own host connection, its own app lock
 * and, later, its own push subscription. The id below is that difference. It is random and says nothing
 * about the person; it never leaves the device as a credential, it only names the client.
 */

const INSTALL_KEY = "openbot.web.install";

export interface WebInstallIdentity {
  /** Random, made once for this installation. */
  id: string;
  createdAt: number;
  /** What the installation is, for a session list: "iPhone", "Android tablet", "Mac". */
  label: string;
}

let cached: WebInstallIdentity | null = null;

/** Whether the app runs as the installed app rather than inside a browser tab. */
export function isInstalledWebApp(): boolean {
  if (typeof window === "undefined") return false;
  // iOS sets `navigator.standalone`; every other browser answers the media query.
  if ("standalone" in window.navigator && window.navigator.standalone === true) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** What the device is, as far as the user agent tells. It is a label, never a check. */
function deviceLabel() {
  const agent = navigator.userAgent;
  const platform =
    "userAgentData" in navigator && isDynamicRecord(navigator.userAgentData)
      ? String(navigator.userAgentData.platform ?? "")
      : "";
  const touch = navigator.maxTouchPoints > 1;
  // An iPad on iOS 13 and later sends a Mac user agent; the touch points give it away.
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && touch)) return "iPad";
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(agent) || /Mac/.test(platform)) return "Mac";
  if (/Windows/.test(agent) || /Win/.test(platform)) return "Windows";
  if (/Linux/.test(agent) || /Linux/.test(platform)) return "Linux";
  return "Browser";
}

function readStored(): WebInstallIdentity | null {
  try {
    const raw = window.localStorage.getItem(INSTALL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isDynamicRecord(parsed)) return null;
    const { id, createdAt, label } = parsed;
    if (!isString(id) || !id) return null;
    if (!isNumber(createdAt) || !Number.isFinite(createdAt)) return null;
    return { id, createdAt, label: isString(label) && label ? label : deviceLabel() };
  } catch {
    return null;
  }
}

/**
 * The identity of this installation. A browser without storage gets a new one on every load, which is
 * still correct: the account session of that browser is new on every load too.
 */
export function webInstallIdentity(): WebInstallIdentity {
  if (cached) return cached;
  const stored = readStored();
  if (stored) {
    cached = stored;
    return stored;
  }
  const made: WebInstallIdentity = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    label: deviceLabel(),
  };
  cached = made;
  try {
    window.localStorage.setItem(INSTALL_KEY, JSON.stringify(made));
  } catch {
    // As above: without storage the identity lives for this load only.
  }
  return made;
}
