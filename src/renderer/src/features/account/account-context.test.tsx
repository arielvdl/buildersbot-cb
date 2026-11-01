import type { CentralAuthState } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./account-context";
import type { AccountPort } from "./account-port";

const SIGNED_IN: CentralAuthState = {
  status: "signed_in",
  user: { id: "user-1", email: "owner@example.com", name: "Owner", avatarUrl: null },
};
const OTHER_ACCOUNT: CentralAuthState = {
  status: "signed_in",
  user: { id: "user-2", email: "other@example.com", name: "Other", avatarUrl: null },
};
/** What main gives when the account service does not answer. The sign-in screen offers Try again. */
const SERVICE_OUTAGE: CentralAuthState = {
  status: "error",
  issue: { code: "auth_api_unavailable", message: "The account service is not available." },
};
/** How an IPC call fails when main has no handler for it yet. */
const NO_HANDLER = new Error("No handler registered for 'auth:get-state'");

type AuthPort = Pick<AccountPort["auth"], "getState" | "onEvent">;

/** Mounts the account context on a port that answers each read with the next entry of `reads`. */
function mount(reads: Array<() => Promise<CentralAuthState>>) {
  let emit: (state: CentralAuthState) => void = () => undefined;
  const getState = vi.fn(() => {
    const next = reads.shift();
    if (!next) throw new Error("No more account reads were expected.");
    return next();
  });
  const port: AuthPort = {
    getState,
    onEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
  };
  Object.defineProperty(window, "openbot", { value: { auth: port }, configurable: true });
  let auth: ReturnType<typeof useAuth> | undefined;
  function Probe() {
    auth = useAuth();
    return null;
  }
  render(() => (
    <AuthProvider>
      <Probe />
    </AuthProvider>
  ));
  if (!auth) throw new Error("The account context was not created.");
  return { auth, getState, emit: (state: CentralAuthState) => emit(state) };
}

function showWindow(): void {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function issueCode(state: CentralAuthState): string | null {
  return state.status === "error" ? state.issue.code : null;
}

describe("the account bootstrap read", () => {
  it("reads the account again when the window gets focus after a read that main could not answer", async () => {
    const { auth, getState } = mount([() => Promise.reject(NO_HANDLER), () => Promise.resolve(SIGNED_IN)]);
    await vi.waitFor(() => expect(issueCode(auth.centralAuth())).toBe("auth_unavailable"));

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(auth.centralAuth()).toEqual(SIGNED_IN));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("keeps the error while main cannot answer, then shows the outage that main reports", async () => {
    const { auth, getState } = mount([
      () => Promise.reject(NO_HANDLER),
      () => Promise.reject(NO_HANDLER),
      () => Promise.resolve(SERVICE_OUTAGE),
    ]);
    await vi.waitFor(() => expect(issueCode(auth.centralAuth())).toBe("auth_unavailable"));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    expect(issueCode(auth.centralAuth())).toBe("auth_unavailable");

    // The window shows again after the second read failed. Main answers now, and its outage is not hidden.
    await vi.waitFor(() => {
      showWindow();
      expect(getState).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => expect(auth.centralAuth()).toEqual(SERVICE_OUTAGE));

    // An answer stops the reads: the user tries the outage again with its own button.
    window.dispatchEvent(new Event("focus"));
    showWindow();
    expect(getState).toHaveBeenCalledTimes(3);
  });

  it("does not replace an account event with a read that answers after it", async () => {
    let answerLate: (state: CentralAuthState) => void = () => undefined;
    const lateRead = new Promise<CentralAuthState>((resolve) => {
      answerLate = resolve;
    });
    const { auth, getState, emit } = mount([() => Promise.reject(NO_HANDLER), () => lateRead]);
    await vi.waitFor(() => expect(issueCode(auth.centralAuth())).toBe("auth_unavailable"));

    window.dispatchEvent(new Event("focus"));
    expect(getState).toHaveBeenCalledTimes(2);
    emit(OTHER_ACCOUNT);
    answerLate(SIGNED_IN);
    // The context reads the late answer before this line continues: it subscribed first.
    await lateRead;

    expect(auth.centralAuth()).toEqual(OTHER_ACCOUNT);
  });
});
