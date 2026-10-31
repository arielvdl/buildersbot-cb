import type { CentralAuthIssue } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { currentText } from "@openbot/ui/text";
import { createSignal, onCleanup } from "solid-js";
import type { DeviceSignInView } from "../account/account-context";

/**
 * The Cultura Builder sign-in of the web app: the Hub device grant (RFC 8628) through the account
 * service (`/api/browser/device/*`).
 *
 * The service keeps the flow ID in an HttpOnly cookie of this browser, so this module never sees it:
 * it shows the code and the Hub address, and polls with the tag of its flow, which names that cookie.
 * It polls at the interval that the service gives and never faster. A `slow_down` adds 5 seconds to
 * the interval for the rest of the flow, as the RFC asks, and the wait is never shorter than the
 * `Retry-After` of the answer. When the page comes back into view, for example after the Hub tab, it
 * polls as soon as the interval allows.
 *
 * A phone can reload the web app while the person is on the Hub, for example when it closes the page
 * to free memory. The code, the tag and the Hub address wait in the session storage of the tab until
 * the flow ends, so the page that loads again polls the same flow. They are not secrets: without the
 * HttpOnly cookie, nobody can poll the flow.
 */

/** RFC 8628, section 3.5: each `slow_down` adds 5 seconds to the interval. */
const SLOW_DOWN_STEP_MS = 5_000;
/** RFC 8628, section 3.2: the interval when the answer gives none. */
const DEFAULT_INTERVAL_MS = 5_000;
/** Dropped requests or bridge failures in a row before the flow stops, as on desktop. */
const MAX_POLL_FAILURES = 6;
/** The session storage key of the flow that waits. */
const SAVED_FLOW_KEY = "buildersbot.web.deviceSignIn";
/** The service makes the tag from 8 random bytes in base64url. */
const FLOW_TAG = /^[A-Za-z0-9_-]{11}$/u;

export type WebDeviceSignInStep = "start" | "poll" | "cancel";

/** Where the flow that waits is kept across a reload of the page. */
export interface WebDeviceFlowStore {
  read: () => string | null;
  write: (value: string | null) => void;
}

export interface WebDeviceSignInOptions {
  /** One same-origin POST to `/api/browser/device/<step>`, with the tag of the flow for a poll or a cancel. */
  post: (step: WebDeviceSignInStep, body: { flow?: string }) => Promise<Response>;
  /** The approval. The answer carries the account, and the session cookie is already set. */
  onAuthorized: (value: DynamicRecord | null) => Promise<void>;
  /** The flow could not start or stopped for good. The sign-in screen shows the issue. */
  onFailed: (issue: CentralAuthIssue) => void;
  /**
   * An earlier poll took the approval of this code, for example in another tab of this browser. The
   * session cookie can already be set, so the page checks the session.
   */
  onUsed: () => void;
  /** The session storage of the tab by default. */
  store?: WebDeviceFlowStore;
}

/** The session storage of the tab. A browser that keeps nothing only loses the resume after a reload. */
const sessionFlowStore: WebDeviceFlowStore = {
  read: () => {
    try {
      return sessionStorage.getItem(SAVED_FLOW_KEY);
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      if (value === null) sessionStorage.removeItem(SAVED_FLOW_KEY);
      else sessionStorage.setItem(SAVED_FLOW_KEY, value);
    } catch {
      // Private mode or blocked storage: the flow still runs, it only does not survive a reload.
    }
  },
};

type WaitingView = Extract<DeviceSignInView, { phase: "waiting" }>;

interface SavedFlow {
  flow: string;
  intervalMs: number;
  view: Omit<WaitingView, "pausedUntil">;
}

/** The flow that the store keeps, or null when it keeps none or a value that this page did not write. */
function readSavedFlow(store: WebDeviceFlowStore): SavedFlow | null {
  let value: unknown;
  try {
    value = JSON.parse(store.read() ?? "null");
  } catch {
    return null;
  }
  if (!isDynamicRecord(value)) return null;
  const { flow, intervalMs, userCode, verificationUrl, verificationUrlComplete, expiresAt } = value;
  const url = hubAddress(verificationUrl);
  if (
    !isString(flow) ||
    !FLOW_TAG.test(flow) ||
    !isNumber(intervalMs) ||
    !isString(userCode) ||
    !url ||
    !isNumber(expiresAt)
  )
    return null;
  return {
    flow,
    intervalMs: Math.max(1_000, intervalMs),
    view: {
      phase: "waiting",
      userCode,
      verificationUrl: url,
      verificationUrlComplete: hubAddress(verificationUrlComplete),
      expiresAt,
    },
  };
}

/** The JSON object of an answer, or null. */
async function readJson(response: Response): Promise<DynamicRecord | null> {
  try {
    const value = await response.json();
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response): number {
  const seconds = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
}

/** The refusal that the service gave, or the fallback text with `code`. */
function issueFrom(body: DynamicRecord | null, response: Response, code: string, fallback: string): CentralAuthIssue {
  const error = body && isDynamicRecord(body.error) ? body.error : null;
  const retryAfterSeconds = Math.ceil(retryAfterMs(response) / 1_000);
  return {
    code: error && isString(error.code) ? error.code : code,
    message: error && isString(error.message) ? error.message : fallback,
    ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
  };
}

/** A Hub address that the page may show and open: HTTPS, or HTTP in a development build. */
function hubAddress(value: unknown): string | null {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (import.meta.env.DEV && url.protocol === "http:") ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createWebDeviceSignIn(options: WebDeviceSignInOptions) {
  const store = options.store ?? sessionFlowStore;
  const [view, setView] = createSignal<DeviceSignInView | null>(null);
  /** Bumped by each start, cancel and new poll loop, so a late answer cannot change a newer flow. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let lastPollAt = 0;
  let failures = 0;
  /** The tag of the flow that this page polls. It names the HttpOnly cookie of that flow. */
  let flowTag: string | null = null;
  /** A poll waits for its answer. An approval sets the cookie in that answer, so it is never dropped. */
  let inFlight = false;

  function stop(): void {
    generation += 1;
    failures = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  /** The flow ended: the page forgets it, and a reload does not poll it again. */
  function end(next: DeviceSignInView | null): void {
    stop();
    flowTag = null;
    store.write(null);
    setView(next);
  }

  /** Keeps the flow for a reload, in the shape that `readSavedFlow` reads. */
  function save(waiting: WaitingView): void {
    if (!flowTag) return;
    const { pausedUntil: _paused, ...view } = waiting;
    store.write(JSON.stringify({ ...view, flow: flowTag, intervalMs }));
  }

  function schedule(delayMs: number): void {
    if (timer !== undefined) clearTimeout(timer);
    const current = generation;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (current === generation) void poll(current);
      },
      Math.max(0, delayMs),
    );
  }

  function fail(issue: CentralAuthIssue): void {
    end(null);
    options.onFailed(issue);
  }

  /** A dropped request or a bridge failure: the code still lives, so try again at the same pace. */
  function pollFailed(): void {
    failures += 1;
    if (failures <= MAX_POLL_FAILURES) {
      schedule(intervalMs);
      return;
    }
    fail({ code: "device_sign_in_failed", message: currentText().t("account.login.deviceFailed") });
  }

  async function authorized(response: Response): Promise<void> {
    const body = await readJson(response);
    end(null);
    try {
      await options.onAuthorized(body);
    } catch {
      // The session cookie is set, so a new check of the session can still find the account.
      options.onFailed({ code: "device_sign_in_failed", message: currentText().t("account.login.deviceFailed") });
    }
  }

  async function poll(current: number): Promise<void> {
    const waiting = view();
    const flow = flowTag;
    if (waiting?.phase !== "waiting" || !flow) return;
    if (Date.now() >= waiting.expiresAt) {
      end({ phase: "expired" });
      return;
    }
    if (waiting.pausedUntil !== undefined) {
      const { pausedUntil: _paused, ...resumed } = waiting;
      setView(resumed);
    }
    lastPollAt = Date.now();
    let response: Response;
    inFlight = true;
    try {
      response = await options.post("poll", { flow });
    } catch {
      if (current === generation) pollFailed();
      return;
    } finally {
      inFlight = false;
    }
    // The approval set the session cookie in this answer, so it counts even when a newer flow started.
    if (response.status === 200) {
      await authorized(response);
      return;
    }
    if (current !== generation) return;
    if (response.status === 202) {
      failures = 0;
      const body = await readJson(response);
      const seconds = body && isNumber(body.interval) ? body.interval : 0;
      // The interval only grows: a `slow_down` stays for the rest of the flow.
      intervalMs = Math.max(intervalMs, seconds * 1_000);
      schedule(intervalMs);
      return;
    }
    const body = await readJson(response);
    if (current !== generation) return;
    const code = body && isDynamicRecord(body.error) && isString(body.error.code) ? body.error.code : null;
    if (response.status === 429) {
      failures = 0;
      const wait = retryAfterMs(response);
      if (code === "slow_down") {
        intervalMs += SLOW_DOWN_STEP_MS;
        const next = view();
        if (next?.phase === "waiting") save(next);
        schedule(Math.max(intervalMs, wait));
        return;
      }
      // The account service's own limit: the same code stays, and the polls start again by themselves.
      const pausedUntil = Date.now() + Math.max(intervalMs, wait);
      setView({ ...waiting, pausedUntil });
      schedule(pausedUntil - Date.now());
      return;
    }
    if (response.status === 403) {
      end({ phase: "denied" });
      return;
    }
    if (response.status === 410) {
      end({ phase: "expired" });
      if (code === "flow_consumed") options.onUsed();
      return;
    }
    pollFailed();
  }

  /** Asks the Hub for a new code. A flow that runs stops first, and the service forgets it. */
  async function start(): Promise<void> {
    const previous = flowTag;
    end({ phase: "starting" });
    if (previous) void options.post("cancel", { flow: previous }).catch(() => undefined);
    const current = generation;
    intervalMs = DEFAULT_INTERVAL_MS;
    const failed = (body: DynamicRecord | null, response: Response | null) => {
      const text = currentText();
      const fallback = text.t("account.login.deviceStartFailed");
      fail(
        response
          ? issueFrom(body, response, "device_sign_in_failed", fallback)
          : { code: "device_sign_in_failed", message: fallback },
      );
    };
    let response: Response;
    try {
      response = await options.post("start", {});
    } catch {
      if (current === generation) failed(null, null);
      return;
    }
    const body = await readJson(response);
    if (current !== generation) return;
    if (!response.ok || !body) {
      failed(body, response);
      return;
    }
    const verificationUrl = hubAddress(body.verificationUri);
    if (
      !isString(body.flow) ||
      !FLOW_TAG.test(body.flow) ||
      !isString(body.userCode) ||
      !verificationUrl ||
      !isNumber(body.expiresIn)
    ) {
      failed(null, null);
      return;
    }
    flowTag = body.flow;
    intervalMs = Math.max(1_000, (isNumber(body.interval) ? body.interval : 5) * 1_000);
    const waiting: WaitingView = {
      phase: "waiting",
      userCode: body.userCode,
      verificationUrl,
      verificationUrlComplete: hubAddress(body.verificationUriComplete),
      expiresAt: Date.now() + body.expiresIn * 1_000,
    };
    setView(waiting);
    save(waiting);
    lastPollAt = Date.now();
    schedule(intervalMs);
  }

  /**
   * Polls again the flow that this tab kept before a reload, at once: the approval may have come while
   * the page was away. Returns false when the tab keeps no flow that still lives.
   */
  function resume(): boolean {
    if (view() !== null) return false;
    const saved = readSavedFlow(store);
    if (!saved || saved.view.expiresAt <= Date.now()) {
      store.write(null);
      return false;
    }
    stop();
    flowTag = saved.flow;
    intervalMs = saved.intervalMs;
    setView(saved.view);
    lastPollAt = 0;
    schedule(0);
    return true;
  }

  /** "I have signed in", a resume after a pause, or a return to the page: poll as soon as the interval allows. */
  function checkNow(): void {
    const waiting = view();
    if (waiting?.phase !== "waiting") {
      void start();
      return;
    }
    if (inFlight || (waiting.pausedUntil !== undefined && waiting.pausedUntil > Date.now())) return;
    schedule(lastPollAt + intervalMs - Date.now());
  }

  /** Closes the sign-in. The service forgets the flow of this browser; the Hub code expires by itself. */
  function cancel(): void {
    const flow = flowTag;
    end(null);
    if (flow) void options.post("cancel", { flow }).catch(() => undefined);
  }

  /**
   * The account is signed in another way, for example in another tab: the flow of this page has no
   * use. The service is not asked: the cookie of the flow ends with the code.
   */
  function forget(): void {
    if (view() !== null || flowTag !== null) end(null);
  }

  const onVisible = () => {
    if (document.visibilityState === "visible" && view()?.phase === "waiting") checkNow();
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisible);
    stop();
  });

  return { view, start, resume, checkNow, cancel, forget };
}
