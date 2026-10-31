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
 * it shows the code and the Hub address, and polls. It polls at the interval that the service gives
 * and never faster. A `slow_down` adds 5 seconds to the interval for the rest of the flow, as the
 * RFC asks, and the wait is never shorter than the `Retry-After` of the answer. When the page comes
 * back into view, for example after the Hub tab, it polls as soon as the interval allows.
 */

/** RFC 8628, section 3.5: each `slow_down` adds 5 seconds to the interval. */
const SLOW_DOWN_STEP_MS = 5_000;
/** RFC 8628, section 3.2: the interval when the answer gives none. */
const DEFAULT_INTERVAL_MS = 5_000;
/** Dropped requests or bridge failures in a row before the flow stops, as on desktop. */
const MAX_POLL_FAILURES = 6;

export type WebDeviceSignInStep = "start" | "poll" | "cancel";

export interface WebDeviceSignInOptions {
  /** One same-origin POST to `/api/browser/device/<step>`. */
  post: (step: WebDeviceSignInStep) => Promise<Response>;
  /** The approval. The answer carries the account, and the session cookie is already set. */
  onAuthorized: (value: DynamicRecord | null) => Promise<void>;
  /** The flow could not start or stopped for good. The sign-in screen shows the issue. */
  onFailed: (issue: CentralAuthIssue) => void;
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
  const [view, setView] = createSignal<DeviceSignInView | null>(null);
  /** Bumped by each start, cancel and new poll loop, so a late answer cannot change a newer flow. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let lastPollAt = 0;
  let failures = 0;
  /** A poll waits for its answer. An approval sets the cookie in that answer, so it is never dropped. */
  let inFlight = false;

  function stop(): void {
    generation += 1;
    failures = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
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
    stop();
    setView(null);
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

  async function poll(current: number): Promise<void> {
    const waiting = view();
    if (waiting?.phase !== "waiting") return;
    if (Date.now() >= waiting.expiresAt) {
      stop();
      setView({ phase: "expired" });
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
      response = await options.post("poll");
    } catch {
      if (current === generation) pollFailed();
      return;
    } finally {
      inFlight = false;
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
    if (response.ok) {
      const body = await readJson(response);
      if (current !== generation) return;
      stop();
      setView(null);
      try {
        await options.onAuthorized(body);
      } catch {
        // The session cookie is set, so a new check of the session can still find the account.
        options.onFailed({ code: "device_sign_in_failed", message: currentText().t("account.login.deviceFailed") });
      }
      return;
    }
    const body = await readJson(response);
    if (current !== generation) return;
    if (response.status === 429) {
      failures = 0;
      const wait = retryAfterMs(response);
      if (body && isDynamicRecord(body.error) && body.error.code === "slow_down") {
        intervalMs += SLOW_DOWN_STEP_MS;
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
      stop();
      setView({ phase: "denied" });
      return;
    }
    if (response.status === 410) {
      stop();
      setView({ phase: "expired" });
      return;
    }
    pollFailed();
  }

  /** Asks the Hub for a new code. A flow that runs stops first. */
  async function start(): Promise<void> {
    stop();
    const current = generation;
    intervalMs = DEFAULT_INTERVAL_MS;
    setView({ phase: "starting" });
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
      response = await options.post("start");
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
    if (!isString(body.userCode) || !verificationUrl || !isNumber(body.expiresIn)) {
      failed(null, null);
      return;
    }
    intervalMs = Math.max(1_000, (isNumber(body.interval) ? body.interval : 5) * 1_000);
    setView({
      phase: "waiting",
      userCode: body.userCode,
      verificationUrl,
      verificationUrlComplete: hubAddress(body.verificationUriComplete),
      expiresAt: Date.now() + body.expiresIn * 1_000,
    });
    lastPollAt = Date.now();
    schedule(intervalMs);
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
    stop();
    setView(null);
    void options.post("cancel").catch(() => undefined);
  }

  const onVisible = () => {
    if (document.visibilityState === "visible" && view()?.phase === "waiting") checkNow();
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisible);
    stop();
  });

  return { view, start, checkNow, cancel };
}
