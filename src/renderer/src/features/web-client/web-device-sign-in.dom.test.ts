import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebDeviceSignIn,
  type WebDeviceFlowStore,
  type WebDeviceSignInOptions,
  type WebDeviceSignInStep,
} from "./web-device-sign-in";

// The polling of the web app's Cultura Builder sign-in, with fake timers and a fake account service:
// the interval of the service and never faster, the RFC 8628 slow_down, the pause of the service's own
// limit, the end of a flow, an approval that a newer flow must not drop, and the resume after a reload.

const TAG = "AbCdEfGh_-1";
const HUB = "https://hub.culturabuilder.com/hub/builder-ai/device";

interface Call {
  step: WebDeviceSignInStep;
  flow: string | undefined;
  at: number;
}

function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function started(flow = TAG, interval = 5): Response {
  return answer(200, {
    flow,
    userCode: "ABCD-EFGH",
    verificationUri: HUB,
    verificationUriComplete: `${HUB}?code=ABCD-EFGH`,
    expiresIn: 900,
    interval,
  });
}

function memoryStore(initial: string | null = null): WebDeviceFlowStore & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
  };
}

/**
 * A sign-in with a fake service. Each request takes the next answer of its step; a function answer
 * can hold the request open.
 */
function harness(answers: Partial<Record<WebDeviceSignInStep, Array<Response | (() => Promise<Response>)>>>) {
  const calls: Call[] = [];
  const authorized: unknown[] = [];
  const failed: string[] = [];
  let used = 0;
  const store = memoryStore();
  const options: WebDeviceSignInOptions = {
    post: (step, body) => {
      calls.push({ step, flow: body.flow, at: Date.now() });
      const next = answers[step]?.shift();
      if (next === undefined)
        return step === "cancel" ? Promise.resolve(answer(200)) : Promise.reject(new TypeError("offline"));
      return typeof next === "function" ? next() : Promise.resolve(next);
    },
    onAuthorized: async (value) => {
      authorized.push(value);
    },
    onFailed: (issue) => failed.push(issue.code),
    onUsed: () => {
      used += 1;
    },
    store,
  };
  let dispose = () => undefined;
  const signIn = createRoot((root) => {
    dispose = () => {
      root();
      return undefined;
    };
    return createWebDeviceSignIn(options);
  });
  disposers.push(dispose);
  return {
    signIn,
    calls,
    authorized,
    failed,
    store,
    used: () => used,
    polls: () => calls.filter((call) => call.step === "poll"),
  };
}

const disposers: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

describe("web app Cultura Builder sign-in polling", () => {
  it("polls with the flow tag at the interval of the service, never faster", async () => {
    const { signIn, polls, store } = harness({
      start: [started()],
      poll: [answer(202, { interval: 5 }), answer(202, { interval: 5 })],
    });
    await signIn.start();
    expect(signIn.view()).toMatchObject({ phase: "waiting", userCode: "ABCD-EFGH" });
    expect(JSON.parse(store.value ?? "null")).toMatchObject({ flow: TAG, userCode: "ABCD-EFGH" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls().map((call) => [call.flow, call.at - 1_000_000])).toEqual([
      [TAG, 5_000],
      [TAG, 10_000],
    ]);
  });

  it("adds 5 seconds for each slow_down, for the rest of the flow, and waits at least its Retry-After", async () => {
    const { signIn, polls } = harness({
      start: [started()],
      poll: [
        answer(429, { error: { code: "slow_down" } }, { "Retry-After": "12" }),
        answer(202, { interval: 5 }),
        answer(202, { interval: 5 }),
      ],
    });
    await signIn.start();
    await vi.advanceTimersByTimeAsync(5_000);
    // 10 seconds after the slow_down, but the answer asked for 12.
    await vi.advanceTimersByTimeAsync(11_999);
    expect(polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toHaveLength(2);
    // The interval stays 10 seconds, though the service says 5 again.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toHaveLength(3);
  });

  it("pauses on the service's own limit and starts the polls again by itself", async () => {
    const { signIn, polls } = harness({
      start: [started()],
      poll: [answer(429, { error: { code: "rate_limited" } }, { "Retry-After": "30" }), answer(202, { interval: 5 })],
    });
    await signIn.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signIn.view()).toMatchObject({ phase: "waiting", pausedUntil: 1_000_000 + 5_000 + 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls()).toHaveLength(2);
    expect(signIn.view()).not.toHaveProperty("pausedUntil");
  });

  it.each([
    [403, "access_denied", "denied", 0],
    [410, "expired_token", "expired", 0],
    [410, "flow_consumed", "expired", 1],
  ] as const)("ends the flow on %i %s", async (status, code, phase, used) => {
    const sign = harness({ start: [started()], poll: [answer(status, { error: { code } })] });
    await sign.signIn.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sign.signIn.view()).toEqual({ phase });
    expect(sign.used()).toBe(used);
    expect(sign.store.value).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sign.polls()).toHaveLength(1);
  });

  it("stops after six failed polls in a row", async () => {
    const { signIn, polls, failed } = harness({ start: [started()] });
    await signIn.start();
    await vi.advanceTimersByTimeAsync(5_000 * 6);
    expect(failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls()).toHaveLength(7);
    expect(failed).toEqual(["device_sign_in_failed"]);
    expect(signIn.view()).toBeNull();
  });

  it("keeps an approval that arrives after a new code was asked for", async () => {
    let approve: (response: Response) => void = () => undefined;
    const { signIn, authorized, calls } = harness({
      start: [started(), started("ZyXwVuTs_-2")],
      poll: [() => new Promise<Response>((resolve) => (approve = resolve))],
    });
    await signIn.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await signIn.start();
    expect(calls.filter((call) => call.step === "cancel").map((call) => call.flow)).toEqual([TAG]);
    approve(answer(200, { user: { id: "user-1", email: "person@example.com" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(authorized).toEqual([{ user: { id: "user-1", email: "person@example.com" } }]);
    expect(signIn.view()).toBeNull();
  });

  it("does not poll again while a poll waits, when the page comes back into view", async () => {
    let finish: (response: Response) => void = () => undefined;
    const { signIn, polls } = harness({
      start: [started()],
      poll: [() => new Promise<Response>((resolve) => (finish = resolve)), answer(202, { interval: 5 })],
    });
    await signIn.start();
    await vi.advanceTimersByTimeAsync(5_000);
    document.dispatchEvent(new Event("visibilitychange"));
    signIn.checkNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls()).toHaveLength(1);
    finish(answer(202, { interval: 5 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls()).toHaveLength(2);
  });

  it("polls again at once the flow that the tab kept before a reload", async () => {
    const first = harness({ start: [started()] });
    await first.signIn.start();
    const saved = first.store.value;
    const reloaded = harness({ poll: [answer(200, { user: { id: "user-1", email: "person@example.com" } })] });
    reloaded.store.value = saved;
    expect(reloaded.signIn.resume()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reloaded.polls().map((call) => call.flow)).toEqual([TAG]);
    expect(reloaded.authorized).toHaveLength(1);
    expect(reloaded.store.value).toBeNull();
  });

  it("does not resume a flow that expired or a value that it did not write", async () => {
    const expired = harness({});
    expired.store.value = JSON.stringify({
      flow: TAG,
      intervalMs: 5_000,
      userCode: "ABCD-EFGH",
      verificationUrl: HUB,
      verificationUrlComplete: null,
      expiresAt: 999_999,
    });
    expect(expired.signIn.resume()).toBe(false);
    expect(expired.store.value).toBeNull();
    const foreign = harness({});
    foreign.store.value = JSON.stringify({ flow: "../x", userCode: "A", verificationUrl: "javascript:alert(1)" });
    expect(foreign.signIn.resume()).toBe(false);
    expect(foreign.polls()).toEqual([]);
  });

  it("forgets the flow, without asking the service, when the account signs in another way", async () => {
    const { signIn, calls, store } = harness({ start: [started()] });
    await signIn.start();
    signIn.forget();
    // Solid applies a signal write when the current task ends.
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn.view()).toBeNull();
    expect(store.value).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.map((call) => call.step)).toEqual(["start"]);
  });
});
