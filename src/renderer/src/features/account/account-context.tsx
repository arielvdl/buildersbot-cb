import type {
  AccountUsage,
  AccountUsageLimit,
  AvatarImageInput,
  CentralAuthDevicePoll,
  CentralAuthState,
} from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createMemo, createSignal, createStore, flush, onCleanup, onSettled } from "solid-js";
import { type DesktopAnalyticsProperties, desktopAnalytics } from "../../analytics";
import { createSimpleContext } from "../../simple-context";
import { accountPort } from "./account-port";

type MobileConnectAction = DesktopAnalyticsProperties<"mobile_connect_action">["action"];

/**
 * One device sign-in as the sign-in dialog shows it. The flow id stays in this module: the dialog
 * shows the code and the page, and `pollDeviceSignIn` is what the account service answers to.
 */
export type DeviceSignInView =
  | { phase: "starting" }
  | {
      phase: "waiting";
      userCode: string;
      verificationUrl: string;
      verificationUrlComplete: string | null;
      expiresAt: number;
      /** Epoch milliseconds. A 429 paused the polls; the dialog counts down and offers a new try. */
      pausedUntil?: number;
    }
  | { phase: "expired" }
  | { phase: "denied" };

/** How long the sign-in success animation holds the account out of the view. */
const AUTH_SUCCESS_HOLD_MS = 600;

/**
 * Consecutive device-poll failures tolerated before giving up on the flow. A device code lives for
 * minutes and polls every few seconds, so one dropped request or a slow Hub answer is routine, not
 * a refusal - the same reasoning `pollCulturaBuilderToken` already applies to its own network errors.
 * Only a real streak, long enough that retrying at the same pace could not be a fluke, ends the flow.
 */
const MAX_DEVICE_POLL_FAILURES = 6;

/**
 * Analytics only carries codes the account service is known to send, so an
 * unrecognised one becomes `unknown` rather than leaking a new string into the
 * property vocabulary.
 */
function authFailureCode(value: string | undefined): string {
  switch (value) {
    case "auth_api_error":
    case "code_recently_sent":
    case "email_delivery_failed":
    case "email_delivery_not_configured":
    case "email_delivery_rate_limited":
    case "email_sign_in_failed":
    case "email_sign_in_start_failed":
    case "invalid_email":
    case "invalid_sign_in_code":
    case "rate_limited":
    case "sign_in_code_expired":
    case "too_many_code_attempts":
    case "unauthorized":
      return value;
    default:
      return "unknown";
  }
}

/**
 * The cloud account: sign-in state, the signed-in user, plan usage, and the
 * commands that change any of them.
 *
 * Ungated, against the plan's `centralAuth().status !== "loading"`. Two reasons,
 * and the second is decisive:
 *
 * - `"loading"` is not only a startup state. `retryCentralAccount` sets it
 *   deliberately, so a gate here would unmount the whole app - including the
 *   sign-in form whose Retry button was just pressed - and remount it when the
 *   retry resolved.
 * - `AccountLogin` is handed `centralAuth()` and renders the loading state
 *   itself, behind `AppAccessGate`'s own `<Show>`. A provider gate would
 *   withhold that placeholder too, leaving a blank window instead, and would
 *   serialize every bootstrap load that runs in parallel with `auth.getState()`
 *   today.
 *
 * The account is still a gate for the *view*; `visibleSignedInAccount` is what
 * `AppAccessGate` waits on, and it stays here.
 */
const Auth = createSimpleContext({
  name: "Auth",
  init: () => {
    const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({ status: "loading" });
    const [authSuccessVisible, setAuthSuccessVisible] = createSignal(false);
    const [deviceSignIn, setDeviceSignIn] = createSignal<DeviceSignInView | null>(null);
    /** Bumped by every start and cancel, so a poll that resolves late cannot revive a closed dialog. */
    let deviceSignInGeneration = 0;
    let deviceSignInTimer: ReturnType<typeof setTimeout> | undefined;
    let deviceSignInFlowId: string | null = null;
    /** Consecutive poll failures for the flow `stopDeviceSignIn` last reset; see `MAX_DEVICE_POLL_FAILURES`. */
    let deviceSignInPollFailures = 0;
    const [accountUsageState, setAccountUsageState] = createStore<{
      targetKey: string | null;
      data: AccountUsage | null;
      refreshRevision: number;
    }>({ targetKey: null, data: null, refreshRevision: 0 });
    let accountUsageRequestGeneration = 0;
    /** The providers an event updated while the current refresh runs. Their rows are newer than it. */
    let accountUsageEventIds = new Set<string>();
    let authSuccessTimer: ReturnType<typeof setTimeout> | undefined;
    /** The phones of the last list for this account. A phone that is new in a later list connected since then. */
    let knownMobileDevices: ReadonlySet<string> | null = null;

    onCleanup(() => {
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
      stopDeviceSignIn();
    });

    /**
     * Every state change the account service reports, plus the two side effects
     * that ride along: the analytics identity, and the hold that keeps the
     * workspace out of view while the sign-in success animation plays. The hold
     * only starts on a completed code challenge, so a restart into an already
     * signed-in account goes straight to the workspace.
     */
    function applyCentralAuthState(state: CentralAuthState): void {
      desktopAnalytics.setUser(state.status === "signed_in" ? state.user : null);
      if (state.status !== "signed_in") knownMobileDevices = null;
      const completedCodeChallenge = centralAuth().status === "code_sent" && state.status === "signed_in";
      if (state.status !== "signed_in") {
        if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
        authSuccessTimer = undefined;
        setAuthSuccessVisible(false);
      } else if (completedCodeChallenge) {
        if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
        setAuthSuccessVisible(true);
        authSuccessTimer = setTimeout(() => {
          authSuccessTimer = undefined;
          setAuthSuccessVisible(false);
        }, AUTH_SUCCESS_HOLD_MS);
      }
      setCentralAuth(state);
    }

    onSettled(() => {
      const unsubscribe = accountPort().auth.onEvent((state) => {
        flush(() => applyCentralAuthState(state));
      });
      // The bootstrap read sets the signal directly, not through
      // `applyCentralAuthState`: there is no earlier state to have completed a
      // code challenge against, so a restart into a signed-in account must not
      // play the success hold.
      void accountPort()
        .auth.getState()
        .then(setCentralAuth)
        .catch(() =>
          setCentralAuth({
            status: "error",
            issue: {
              code: "auth_unavailable",
              message: currentText().t("account.login.loadFailed"),
            },
          }),
        );
      return unsubscribe;
    });

    async function requestEmailCode(email: string): Promise<void> {
      const analytics = desktopAnalytics.anonymousScope();
      try {
        const state = await accountPort().auth.requestEmailCode(email);
        analytics.track("account_sign_in_started", {
          result: state.status === "code_sent" ? "code_sent" : "failed",
          ...(state.status === "error" ? { failure_code: authFailureCode(state.issue.code) } : {}),
        });
        applyCentralAuthState(state);
      } catch (error) {
        analytics.track("account_sign_in_started", {
          result: "failed",
          failure_code: "request_failed",
        });
        throw error;
      }
    }

    async function retryCentralAccount(): Promise<void> {
      applyCentralAuthState({ status: "loading" });
      applyCentralAuthState(await accountPort().auth.retry());
    }

    async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
      const anonymousAnalytics = desktopAnalytics.anonymousScope();
      try {
        const state = await accountPort().auth.verifyEmailCode({ challengeId, code });
        applyCentralAuthState(state);
        desktopAnalytics.track("account_sign_in_completed", {
          result: state.status === "signed_in" ? "succeeded" : "failed",
          ...("issue" in state ? { failure_code: authFailureCode(state.issue?.code) } : {}),
        });
      } catch (error) {
        anonymousAnalytics.track("account_sign_in_completed", {
          result: "failed",
          failure_code: "verification_failed",
        });
        throw error;
      }
    }

    function stopDeviceSignIn(): void {
      deviceSignInGeneration += 1;
      deviceSignInPollFailures = 0;
      if (deviceSignInTimer !== undefined) {
        clearTimeout(deviceSignInTimer);
        deviceSignInTimer = undefined;
      }
    }

    /** Closes the dialog and stops polling. The service keeps the flow until it expires. */
    function cancelDeviceSignIn(): void {
      stopDeviceSignIn();
      setDeviceSignIn(null);
    }

    /**
     * Polls a device flow until it ends. The interval is the service's, and `slow_down` arrives as
     * the same `pending` with a larger one, so the loop always takes the number it just read.
     */
    function pollDeviceFlow(flowId: string, generation: number, intervalMs: number): void {
      deviceSignInTimer = setTimeout(() => {
        deviceSignInTimer = undefined;
        if (generation !== deviceSignInGeneration) return;
        void (async () => {
          let poll: CentralAuthDevicePoll;
          try {
            poll = await accountPort().auth.pollDeviceSignIn(flowId);
          } catch {
            if (generation !== deviceSignInGeneration) return;
            deviceSignInPollFailures += 1;
            // A dropped request or a slow Hub answer is not a refusal: the code still lives for
            // minutes, so keep polling at the same pace instead of tearing the flow down over one
            // bad round-trip. Only a real streak ends it.
            if (deviceSignInPollFailures <= MAX_DEVICE_POLL_FAILURES) {
              pollDeviceFlow(flowId, generation, intervalMs);
              return;
            }
            setDeviceSignIn(null);
            applyCentralAuthState({
              status: "error",
              issue: { code: "device_sign_in_failed", message: currentText().t("account.login.deviceFailed") },
            });
            return;
          }
          deviceSignInPollFailures = 0;
          if (generation !== deviceSignInGeneration) return;
          if (poll.status === "pending") {
            pollDeviceFlow(flowId, generation, poll.intervalMs);
            return;
          }
          if (poll.status === "rate_limited") {
            // The flow stays valid; only the polls paused, so the same code stays on screen.
            const current = deviceSignIn();
            const pausedUntil = Date.now() + Math.max(1, poll.retryAfterSeconds) * 1_000;
            if (current?.phase === "waiting") setDeviceSignIn({ ...current, pausedUntil });
            return;
          }
          setDeviceSignIn(null);
          // The authorised poll stored the session in main and reported it on the account state.
          if (poll.status === "authorized") return;
          setDeviceSignIn({ phase: poll.status === "denied" ? "denied" : "expired" });
        })();
      }, intervalMs);
    }

    /** Asks for a new code, after an expired one or a refusal the user wants to retry. */
    async function startDeviceSignIn(): Promise<void> {
      stopDeviceSignIn();
      const generation = deviceSignInGeneration;
      setDeviceSignIn({ phase: "starting" });
      try {
        const started = await accountPort().auth.startDeviceSignIn();
        if (generation !== deviceSignInGeneration) return;
        deviceSignInFlowId = started.flowId;
        setDeviceSignIn({
          phase: "waiting",
          userCode: started.userCode,
          verificationUrl: started.verificationUrl,
          verificationUrlComplete: started.verificationUrlComplete,
          expiresAt: started.expiresAt,
        });
        pollDeviceFlow(started.flowId, generation, started.intervalMs);
      } catch {
        if (generation !== deviceSignInGeneration) return;
        setDeviceSignIn(null);
        applyCentralAuthState({
          status: "error",
          issue: { code: "device_sign_in_failed", message: currentText().t("account.login.deviceStartFailed") },
        });
      }
    }

    /**
     * Polls the same flow again now. Used by "I have signed in" and to resume after a pause the
     * service asked for, with the same code on screen.
     */
    function retryDeviceSignIn(): void {
      const flowId = deviceSignInFlowId;
      const current = deviceSignIn();
      if (!flowId || current?.phase !== "waiting") {
        void startDeviceSignIn();
        return;
      }
      // One poll loop at a time: a second click must not leave the previous timer running.
      stopDeviceSignIn();
      const generation = deviceSignInGeneration;
      const { pausedUntil: _paused, ...waiting } = current;
      setDeviceSignIn(waiting);
      pollDeviceFlow(flowId, generation, 0);
    }

    async function logoutCentralAccount(): Promise<void> {
      const analytics = desktopAnalytics.scope();
      try {
        const state = await accountPort().auth.logout();
        analytics.track("account_sign_out", { result: "succeeded" });
        applyCentralAuthState(state);
      } catch (error) {
        analytics.track("account_sign_out", {
          result: "failed",
          failure_code: "sign_out_failed",
        });
        throw error;
      }
    }

    async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
      applyCentralAuthState(await accountPort().auth.updateAvatar(image));
    }

    async function updateAccountName(name: string): Promise<void> {
      applyCentralAuthState(await accountPort().auth.updateName(name));
    }

    const accountUsage = () => accountUsageState.data;
    const accountUsageRefreshRevision = () => accountUsageState.refreshRevision;
    const accountUsageTargetKey = () => accountUsageState.targetKey;

    /**
     * Selects the target of the reading. The reading stays until a refresh for the new target replaces it,
     * so the rail rings do not go away while providers finish their checks. `invalidateAccountUsage`
     * drops it.
     */
    function selectAccountUsageTarget(targetKey: string | null): void {
      if (accountUsageState.targetKey === targetKey) return;
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.targetKey = targetKey;
      });
    }

    function invalidateAccountUsage(): void {
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.data = null;
        state.refreshRevision += 1;
      });
    }

    function applyAccountUsage(usage: AccountUsage): void {
      if (usage.limits.length === 0) {
        accountUsageRequestGeneration += 1;
        setAccountUsageState((state) => {
          state.data = usage;
        });
        return;
      }
      for (const limit of usage.limits) accountUsageEventIds.add(usageLimitKey(limit));
      setAccountUsageState((state) => {
        const byId = new Map((state.data?.limits ?? []).map((limit) => [usageLimitKey(limit), limit]));
        for (const limit of usage.limits) byId.set(usageLimitKey(limit), limit);
        state.data = { limits: [...byId.values()] };
      });
    }

    async function refreshAccountUsage(targetKey: string): Promise<AccountUsage> {
      selectAccountUsageTarget(targetKey);
      const generation = ++accountUsageRequestGeneration;
      accountUsageEventIds = new Set();
      const usage = await accountPort().agent.getUsage();
      if (generation === accountUsageRequestGeneration && accountUsageState.targetKey === targetKey) {
        // The refresh reads every provider, so a row it omits has stopped reporting, such as a revoked
        // OpenCode Go key. It keeps only the rows an event updated after it started.
        setAccountUsageState((state) => {
          const byId = new Map(usage.limits.map((limit) => [usageLimitKey(limit), limit]));
          for (const limit of state.data?.limits ?? []) {
            const key = usageLimitKey(limit);
            if (accountUsageEventIds.has(key)) byId.set(key, limit);
          }
          state.data = { limits: [...byId.values()] };
        });
      }
      return usage;
    }

    /** Runs a Mobile Connect call and records its result. A failure still rejects for the panel. */
    function trackMobileConnect<Result>(action: MobileConnectAction, call: () => Promise<Result>): Promise<Result> {
      return call().then(
        (result) => {
          desktopAnalytics.track("mobile_connect_action", { action, result: "succeeded" });
          return result;
        },
        (error: unknown) => {
          desktopAnalytics.track("mobile_connect_action", { action, result: "failed" });
          throw error;
        },
      );
    }

    async function listMobileConnectedDevices() {
      const devices = await accountPort().auth.listMobileConnectedDevices();
      const ids = new Set(devices.map((device) => device.sessionId));
      const known = knownMobileDevices;
      if (known) {
        for (const id of ids) {
          if (!known.has(id))
            desktopAnalytics.track("mobile_connect_action", { action: "connected", result: "succeeded" });
        }
      }
      knownMobileDevices = ids;
      return devices;
    }

    function revokeMobileConnectedDevice(sessionId: string) {
      return trackMobileConnect("revoked", () => accountPort().auth.revokeMobileConnectedDevice(sessionId));
    }

    const signedInAccount = createMemo(() => {
      const state = centralAuth();
      return state.status === "signed_in" ? state.user : null;
    });
    /** Null while the success animation holds, so the workspace mounts after it. */
    const visibleSignedInAccount = createMemo(() => (authSuccessVisible() ? null : signedInAccount()));

    return {
      centralAuth,
      signedInAccount,
      visibleSignedInAccount,
      accountUsage,
      accountUsageRefreshRevision,
      accountUsageTargetKey,
      selectAccountUsageTarget,
      invalidateAccountUsage,
      applyAccountUsage,
      refreshAccountUsage,
      requestEmailCode,
      retryCentralAccount,
      verifyEmailCode,
      deviceSignIn,
      startDeviceSignIn,
      retryDeviceSignIn,
      cancelDeviceSignIn,
      logoutCentralAccount,
      updateAccountName,
      updateAccountAvatar,
      getMobileWebAppUrl: () => accountPort().auth.getMobileWebAppUrl(),
      listMobileConnectedDevices,
      revokeMobileConnectedDevice,
      listAccountSessions: () => accountPort().auth.listAccountSessions(),
      revokeAccountSession: (sessionId: string) => accountPort().auth.revokeAccountSession(sessionId),
    };
  },
});

export const AuthProvider = Auth.provider;
export const useAuth = Auth.use;

/** One row for each account of a provider: the provider's own sign-in has no account. */
function usageLimitKey(limit: AccountUsageLimit): string {
  return `${limit.id}\n${limit.accountId ?? ""}`;
}
