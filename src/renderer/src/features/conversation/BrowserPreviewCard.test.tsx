import type { BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import { BrowserPreviewCard } from "@openbot/ui/features/conversation/BrowserPreviewSidebar";
import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAB: BrowserTab = {
  id: "tab-1",
  title: "Docs",
  url: "https://example.com/docs",
  loading: false,
  ownerThreadId: null,
  ownerAgentId: null,
};

/** A card whose host answers each capture with the frame `frame` gives, and the count of captures. */
function card(frame: (call: number) => string) {
  const calls = { count: 0 };
  const capturePreview = async (): Promise<BrowserPreview> => {
    calls.count += 1;
    return { dataUrl: frame(calls.count), width: 960, height: 600 };
  };
  render(() => (
    <BrowserPreviewCard capturePreview={capturePreview} tab={TAB} contextKey="local" enabled onOpen={() => {}} />
  ));
  return calls;
}

/** Fires the card's next timer, and lets the capture it starts settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("BrowserPreviewCard captures", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits longer after each capture that gives the same picture, up to 12 seconds", async () => {
    const calls = card(() => "data:image/jpeg;base64,same");
    await vi.waitFor(() => expect(calls.count).toBe(1));

    await advance(3_000);
    expect(calls.count).toBe(2);
    // The second answer was the same picture: the next capture waits 6 s.
    await advance(5_999);
    expect(calls.count).toBe(2);
    await advance(1);
    expect(calls.count).toBe(3);
    await advance(12_000);
    expect(calls.count).toBe(4);
    // The wait stays at 12 s.
    await advance(12_000);
    expect(calls.count).toBe(5);
  });

  it("captures every 3 seconds while the picture changes", async () => {
    const calls = card((call) => `data:image/jpeg;base64,frame-${call}`);
    await vi.waitFor(() => expect(calls.count).toBe(1));

    await advance(9_000);
    expect(calls.count).toBe(4);
  });
});
