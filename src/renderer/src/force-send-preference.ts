import { createSignal } from "solid-js";

const ASK_BEFORE_FORCE_STORAGE_KEY = "openbot:ask-before-force-send";

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedPreference: boolean | undefined;

/**
 * Whether a force of a queued message asks first, on this device and browser. It asks unless the
 * person chose "Do not ask me again" or turned the setting off. Reading `window.localStorage` throws
 * when the browser blocks storage, so it is read inside the guard.
 */
export function readAskBeforeForce(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return window.localStorage.getItem(ASK_BEFORE_FORCE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeAskBeforeForce(ask: boolean): void {
  try {
    window.localStorage.setItem(ASK_BEFORE_FORCE_STORAGE_KEY, String(ask));
    unsavedPreference = undefined;
  } catch {
    // Blocked or full storage keeps the choice for this page only.
    unsavedPreference = ask;
  }
}

const [askBeforeForce, setAskBeforeForceSignal] = createSignal(readAskBeforeForce());

function readStorageIntoSignal(event: StorageEvent): void {
  if (event.key !== null && event.key !== ASK_BEFORE_FORCE_STORAGE_KEY) return;
  setAskBeforeForceSignal(readAskBeforeForce());
}

if (typeof window !== "undefined") {
  // One registration per page: addEventListener ignores the same listener twice, and HMR
  // disposal removes it when this module is replaced.
  window.addEventListener("storage", readStorageIntoSignal);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignal);
  });
}

/** The shared reactive preference: a Settings change reaches every open composer at once. */
export function useAskBeforeForce(): () => boolean {
  return askBeforeForce;
}

export function setAskBeforeForce(ask: boolean): void {
  writeAskBeforeForce(ask);
  setAskBeforeForceSignal(ask);
}
