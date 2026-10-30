import type { InterruptedWorkOffer, ResumeInterruptedWorkResult } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createResumeOfferController, type ResumeOfferPort } from "./resume-offer-controller";

const offer: InterruptedWorkOffer = {
  channels: [{ id: "c1", name: "Launch", stoppedTasks: 2 }],
  agents: [{ id: "a1", name: "Nova" }],
};

function port(overrides: Partial<ResumeOfferPort> = {}): ResumeOfferPort {
  return {
    getResumeOffer: vi.fn(async () => offer),
    resumeInterruptedWork: vi.fn(async (): Promise<ResumeInterruptedWorkResult> => ({ offer: null, failed: 0 })),
    dismissResumeOffer: vi.fn(async () => {}),
    ...overrides,
  };
}

function mount(calls: ResumeOfferPort) {
  let controller: ReturnType<typeof createResumeOfferController> | undefined;
  render(() => {
    controller = createResumeOfferController(() => calls);
    return null;
  });
  if (!controller) throw new Error("The controller was not created.");
  return controller;
}

describe("the resume offer controller", () => {
  it("shows the modal only when work stopped", async () => {
    const empty = mount(port({ getResumeOffer: vi.fn(async () => null) }));
    const shown = mount(port());

    await vi.waitFor(() => expect(shown.open()).toBe(true));
    expect(empty.open()).toBe(false);
    expect(shown.state.offer).toEqual(offer);
    // Nothing is selected first, and nothing is sent by itself.
    expect(shown.canResumeSelected()).toBe(false);
  });

  it("clears the offer on Not now", async () => {
    const calls = port();
    const controller = mount(calls);
    await vi.waitFor(() => expect(controller.open()).toBe(true));

    await controller.dismiss();
    flush();

    expect(controller.open()).toBe(false);
    expect(calls.dismissResumeOffer).toHaveBeenCalledTimes(1);
    expect(calls.resumeInterruptedWork).not.toHaveBeenCalled();
  });

  it("sends only the selected work, and closes after it", async () => {
    const calls = port();
    const controller = mount(calls);
    await vi.waitFor(() => expect(controller.open()).toBe(true));

    controller.toggleChannel("c1", true);
    // A store write shows after the flush, as it does before the next click.
    flush();
    expect(controller.canResumeSelected()).toBe(true);
    await controller.resumeSelected();
    flush();

    expect(calls.resumeInterruptedWork).toHaveBeenCalledWith({ channelIds: ["c1"], agentIds: [] });
    expect(controller.open()).toBe(false);
  });

  it("sends one request when the user clicks twice", async () => {
    let finish: (result: ResumeInterruptedWorkResult) => void = () => {};
    const resumeInterruptedWork = vi.fn(
      () => new Promise<ResumeInterruptedWorkResult>((resolve) => (finish = resolve)),
    );
    const controller = mount(port({ resumeInterruptedWork }));
    await vi.waitFor(() => expect(controller.open()).toBe(true));

    const first = controller.resumeAll();
    const second = controller.resumeAll();
    finish({ offer: null, failed: 0 });
    await Promise.all([first, second]);

    expect(resumeInterruptedWork).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open and shows the error when the request fails", async () => {
    const controller = mount(port({ resumeInterruptedWork: vi.fn(async () => Promise.reject(new Error("refused"))) }));
    await vi.waitFor(() => expect(controller.open()).toBe(true));

    await controller.resumeAll();
    flush();

    expect(controller.open()).toBe(true);
    expect(controller.state.offer).toEqual(offer);
    expect(controller.state.error).toBe("refused");
    expect(controller.state.pending).toBe(false);
  });

  it("keeps the work that did not start, with an error", async () => {
    const left: InterruptedWorkOffer = { channels: [], agents: [{ id: "a1", name: "Nova" }] };
    const controller = mount(port({ resumeInterruptedWork: vi.fn(async () => ({ offer: left, failed: 1 })) }));
    await vi.waitFor(() => expect(controller.open()).toBe(true));
    controller.toggleChannel("c1", true);
    flush();

    await controller.resumeAll();
    flush();

    expect(controller.open()).toBe(true);
    expect(controller.state.offer).toEqual(left);
    expect(controller.state.error).toBe("");
    // The channel is gone from the offer, so it is no longer selected.
    expect(controller.state.channelIds).toEqual([]);
  });
});
