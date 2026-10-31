// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { memoryIsLow } from "../backend/host-memory";
import { classifyMacMemory, MacMemory, parseFreePercent, parseSwapUsedMb } from "./mac-memory";

describe("reading the numbers of macOS", () => {
  it("reads the free percentage from memory_pressure", () => {
    expect(parseFreePercent("Pages free: 10\n\nSystem-wide memory free percentage: 82%\n")).toBe(82);
    expect(parseFreePercent("System-wide memory free percentage: 7%")).toBe(7);
  });

  it("gives null for text with no such line, or a value out of range", () => {
    expect(parseFreePercent("nothing here")).toBeNull();
    expect(parseFreePercent("System-wide memory free percentage: 250%")).toBeNull();
  });

  it("reads the used swap from sysctl, in MB", () => {
    expect(parseSwapUsedMb("vm.swapusage: total = 6144.00M  used = 4721.50M  free = 1422.50M  (encrypted)")).toBe(4722);
    expect(parseSwapUsedMb("vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M")).toBe(0);
    expect(parseSwapUsedMb("garbage")).toBeNull();
  });
});

describe("the level of the memory", () => {
  const level = (freePercent: number, swapUsedMb: number, previous: "ok" | "low" | "critical" = "ok") =>
    classifyMacMemory({ freePercent, swapUsedMb }, previous);

  it("is ok with plenty of memory, whatever the swap high-water mark says", () => {
    expect(level(60, 0)).toBe("ok");
    expect(level(40, 9000)).toBe("ok");
  });

  it("is low when little is free, or when swap is large and not much is free", () => {
    expect(level(13, 0)).toBe("low");
    expect(level(24, 7000)).toBe("low");
  });

  it("is critical when almost nothing is free, or swap is huge and little is free", () => {
    expect(level(7, 0)).toBe("critical");
    expect(level(14, 9500)).toBe("critical");
  });

  it("does not flap: a level is left only a margin past its threshold", () => {
    expect(level(15, 0, "low")).toBe("low");
    expect(level(19, 0, "low")).toBe("low");
    expect(level(20, 0, "low")).toBe("ok");
    expect(level(9, 0, "critical")).toBe("critical");
    expect(level(13, 0, "critical")).toBe("critical");
    expect(level(14, 0, "critical")).toBe("low");
  });

  it("goes up at once", () => {
    expect(level(5, 0, "ok")).toBe("critical");
    expect(level(10, 0, "ok")).toBe("low");
  });
});

describe("the memory of the Mac as the agents see it", () => {
  function setup() {
    let sample: { freePercent: number; swapUsedMb: number } | null = { freePercent: 60, swapUsedMb: 0 };
    const errors: string[] = [];
    const memory = new MacMemory({
      read: async () => sample,
      onError: (message) => errors.push(message),
    });
    return {
      memory,
      errors,
      set: (next: typeof sample) => {
        sample = next;
      },
    };
  }

  it("is ok until it has read the memory, and does not hold a turn", () => {
    const { memory } = setup();
    expect(memory.level()).toBe("ok");
    expect(memory.hostedPlan).toBe(false);
    expect(memory.kind).toBe("desktop");
  });

  it("follows each sample and tells the listeners after it", async () => {
    const { memory, set } = setup();
    const listener = vi.fn();
    memory.subscribe(listener);
    await memory.sample();
    expect(memory.level()).toBe("ok");
    set({ freePercent: 5, swapUsedMb: 3000 });
    await memory.sample();
    expect(memory.level()).toBe("critical");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops telling a listener that unsubscribed", async () => {
    const { memory } = setup();
    const listener = vi.fn();
    const stop = memory.subscribe(listener);
    stop();
    await memory.sample();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps its level when a read fails, and says so one time", async () => {
    const { memory, set, errors } = setup();
    set({ freePercent: 10, swapUsedMb: 0 });
    await memory.sample();
    expect(memory.level()).toBe("low");
    set(null);
    await memory.sample();
    await memory.sample();
    expect(memory.level()).toBe("low");
    expect(errors).toHaveLength(1);
  });

  it("gives the last reading for the load panel", async () => {
    const { memory, set } = setup();
    expect(memory.reading()).toBeNull();
    set({ freePercent: 31, swapUsedMb: 1200 });
    await memory.sample();
    expect(memory.reading()).toEqual({ level: "ok", freePercent: 31, swapUsedMb: 1200 });
  });

  it("tells the in-app browser that the memory is low, as it tells the broker", async () => {
    const { memory, set } = setup();
    await memory.sample();
    expect(memoryIsLow(memory)).toBe(false);
    set({ freePercent: 10, swapUsedMb: 0 });
    await memory.sample();
    expect(memoryIsLow(memory)).toBe(true);
    set({ freePercent: 5, swapUsedMb: 0 });
    await memory.sample();
    expect(memoryIsLow(memory)).toBe(true);
    // No reading at all: a Linux or Windows desktop.
    expect(memoryIsLow(null)).toBe(false);
  });

  it("does not limit the turns that run together: only the level holds a new one", () => {
    const { memory } = setup();
    expect(memory.turnLimit()).toBeGreaterThanOrEqual(32);
    expect(() => memory.reserveTurn()()).not.toThrow();
  });

  it("does not overlap its own samples", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const memory = new MacMemory({
      read: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ freePercent: 50, swapUsedMb: 0 });
        });
      },
      onError: () => {},
    });
    const first = memory.sample();
    const second = memory.sample();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
