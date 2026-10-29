import { createSignal, onCleanup } from "solid-js";

/**
 * The installed-app side of the web client: the worker that keeps the shell and shows notifications,
 * the update that waits for the person, and the browser's own install prompt.
 *
 * A new release never swaps itself under a running conversation. The worker installs and waits; the
 * page offers the update, and the person takes it when nothing is half done. That is the whole reason
 * this module exists instead of a bare `register()`.
 */

/** Whether this page runs as a website and can have a worker at all. */
function workerCapable(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  // The desktop app loads the same renderer from `file:` or the app protocol, where there is no worker.
  // The development API answers on the loopback names, which count as a secure context.
  const { protocol, hostname } = window.location;
  return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const [updateReady, setUpdateReady] = createSignal(false);
const [canInstall, setCanInstall] = createSignal(false);
let waitingWorker: ServiceWorker | null = null;
let installEvent: (Event & { prompt: () => Promise<void>; userChoice?: Promise<unknown> }) | null = null;
let registered = false;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

/** The install event of Chrome, which is an `Event` with a `prompt` the page calls. */
function isInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && typeof event.prompt === "function";
}

/**
 * Starts the worker and follows the updates. Called once, from the app shell, after the first screen:
 * the worker is not on the way of the sign-in.
 */
export async function registerWebApp(): Promise<void> {
  if (registered || !workerCapable()) return;
  registered = true;
  try {
    // `updateViaCache: "none"` keeps the HTTP cache of the browser from answering with an old worker.
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    // The shell is warm after the first load, so the offline start has something to show.
    void navigator.serviceWorker.ready.then((ready) => ready.active?.postMessage({ type: "WARM" }));
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      setUpdateReady(true);
    }
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // `installed` with a controller already present is an update, not the first install.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          waitingWorker = installing;
          setUpdateReady(true);
        }
      });
    });
  } catch {
    // Without a worker the app works as a plain page; nothing else has to know.
    registered = false;
  }
}

/** Takes the waiting release: the new worker claims the page and the page reloads under it. */
export function applyWebUpdate(): void {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }
  const worker = waitingWorker;
  waitingWorker = null;
  setUpdateReady(false);
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  worker.postMessage({ type: "SKIP_WAITING" });
}

/** The browser's install prompt, kept until the person takes it. */
export function watchInstallPrompt(): () => void {
  if (typeof window === "undefined") return () => {};
  const onPrompt = (event: Event) => {
    // Chrome shows a mini-infobar of its own unless the page takes the event.
    event.preventDefault();
    if (isInstallPromptEvent(event)) installEvent = event;
    setCanInstall(true);
  };
  const onInstalled = () => {
    installEvent = null;
    setCanInstall(false);
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/** Asks the browser to install. `false` means it has no prompt now (iOS, or already installed). */
export async function promptWebInstall(): Promise<boolean> {
  if (!installEvent) return false;
  const event = installEvent;
  installEvent = null;
  setCanInstall(false);
  try {
    await event.prompt();
    return true;
  } catch {
    return false;
  }
}

export interface WebAppInstallState {
  updateReady: () => boolean;
  canInstall: () => boolean;
  applyUpdate: () => void;
  install: () => Promise<boolean>;
}

/** What the settings row shows, and what it calls. */
export function useWebAppInstall(): WebAppInstallState {
  const stop = watchInstallPrompt();
  onCleanup(stop);
  return {
    updateReady,
    canInstall,
    applyUpdate: applyWebUpdate,
    install: promptWebInstall,
  };
}
