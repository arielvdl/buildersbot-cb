import type { QueueDelivery } from "@openbot/contracts/ipc";
import { QueuePanel } from "@openbot/ui/features/conversation/QueuePanel";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

function delivery(id: string, position: number, extra: Partial<QueueDelivery> = {}): QueueDelivery {
  return {
    id,
    messageId: `message-${id}`,
    recipientAgentId: "agent-1",
    sender: { kind: "user" },
    text: `Message ${position}`,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position,
    turnId: null,
    error: null,
    createdAt: new Date(2026, 9, 31, 10, position).toISOString(),
    ...extra,
  };
}

interface Mount {
  deliveries?: QueueDelivery[];
  onForce?: (deliveryId: string) => Promise<boolean>;
  askBeforeForce?: boolean;
  forceUnsupported?: boolean;
  onStopAskingBeforeForce?: () => void;
}

function mount(options: Mount) {
  render(() => (
    <QueuePanel
      deliveries={options.deliveries ?? [delivery("m1", 1), delivery("m2", 2)]}
      canSteer={false}
      onCancel={() => {}}
      onEdit={() => {}}
      onReorder={() => {}}
      onForce={options.onForce}
      askBeforeForce={options.askBeforeForce}
      forceUnsupported={options.forceUnsupported}
      onStopAskingBeforeForce={options.onStopAskingBeforeForce}
    />
  ));
}

const forceButton = (position: number) => screen.getByRole("button", { name: `Force queued message ${position} now` });
const dialog = () => screen.queryByRole("alertdialog", { name: "Force send?" });

describe("the Force now action of a queued message", () => {
  it("is on each queued row, with an accessible name", () => {
    mount({ onForce: async () => true });
    expect(forceButton(1)).toBeEnabled();
    expect(forceButton(2)).toBeEnabled();
  });

  it("is absent with no force action", () => {
    mount({});
    expect(screen.queryByRole("button", { name: /Force queued message/u })).toBeNull();
  });

  it("asks first, and Cancel sends nothing", async () => {
    const onForce = vi.fn(async () => true);
    mount({ onForce, askBeforeForce: true });
    fireEvent.click(forceButton(2));
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.getByText(/stops the agent that is working now/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(onForce).not.toHaveBeenCalled();
  });

  it("closes the question with Escape and sends nothing", async () => {
    const onForce = vi.fn(async () => true);
    mount({ onForce, askBeforeForce: true });
    fireEvent.click(forceButton(1));
    const shown = await screen.findByRole("alertdialog", { name: "Force send?" });
    fireEvent.keyDown(shown, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(onForce).not.toHaveBeenCalled();
  });

  it("forces the message when the person confirms, and keeps asking when the box is clear", async () => {
    const onForce = vi.fn(async () => true);
    const onStopAskingBeforeForce = vi.fn();
    mount({ onForce, askBeforeForce: true, onStopAskingBeforeForce });
    fireEvent.click(forceButton(2));
    fireEvent.click(await screen.findByRole("button", { name: "Force anyway" }));
    await waitFor(() => expect(onForce).toHaveBeenCalledWith("m2"));
    expect(onStopAskingBeforeForce).not.toHaveBeenCalled();
  });

  it("stores “Don’t ask me again” only when the person confirms with the box checked", async () => {
    const onForce = vi.fn(async () => true);
    const onStopAskingBeforeForce = vi.fn();
    mount({ onForce, askBeforeForce: true, onStopAskingBeforeForce });
    fireEvent.click(forceButton(1));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Don’t ask me about this again" }));
    fireEvent.click(screen.getByRole("button", { name: "Force anyway" }));
    await waitFor(() => expect(onForce).toHaveBeenCalledWith("m1"));
    expect(onStopAskingBeforeForce).toHaveBeenCalledTimes(1);
  });

  it("confirms with Enter from the checkbox", async () => {
    const onForce = vi.fn(async () => true);
    mount({ onForce, askBeforeForce: true });
    fireEvent.click(forceButton(2));
    fireEvent.keyDown(await screen.findByRole("checkbox", { name: "Don’t ask me about this again" }), { key: "Enter" });
    await waitFor(() => expect(onForce).toHaveBeenCalledWith("m2"));
  });

  it("forces at once, with no question, after the person chose not to be asked", async () => {
    const onForce = vi.fn(async () => true);
    mount({ onForce, askBeforeForce: false });
    fireEvent.click(forceButton(2));
    await waitFor(() => expect(onForce).toHaveBeenCalledWith("m2"));
    expect(dialog()).toBeNull();
  });

  it("does nothing on a second click while the force is in flight", async () => {
    let finish: (forced: boolean) => void = () => {};
    const onForce = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    mount({ onForce, askBeforeForce: false });
    // A double click: the second click comes before the screen shows the busy button.
    fireEvent.click(forceButton(1));
    fireEvent.click(forceButton(1));
    await waitFor(() => expect(forceButton(1)).toBeDisabled());
    expect(forceButton(1)).toHaveAttribute("aria-busy", "true");
    expect(onForce).toHaveBeenCalledTimes(1);
    finish(true);
    await waitFor(() => expect(forceButton(1)).toBeEnabled());
  });

  it("stays visible but turned off, with no question, when the host is too old", async () => {
    const onForce = vi.fn(async () => true);
    mount({ onForce, askBeforeForce: true, forceUnsupported: true });
    expect(forceButton(1)).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(forceButton(1));
    expect(dialog()).toBeNull();
    expect(onForce).not.toHaveBeenCalled();
  });

  it("is off for a message that is starting or that another editor holds", () => {
    mount({
      onForce: async () => true,
      deliveries: [delivery("m1", 1, { status: "starting" }), delivery("m2", 2, { editing: true })],
    });
    expect(forceButton(1)).toBeDisabled();
    expect(forceButton(2)).toBeDisabled();
  });
});
