import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, powerMonitor: {} }));

const { loopDelayMs } = await import("./resource-monitor");

describe("loopDelayMs", () => {
  it("records no delay for a timer that fired on time at the 100 ms interval", () => {
    expect(loopDelayMs(100e6)).toBe(0);
    expect(loopDelayMs(60e6)).toBe(0);
  });

  it("records the part of a stall past the interval", () => {
    expect(loopDelayMs(350e6)).toBe(250);
  });
});
