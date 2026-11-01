// The tabs of a channel: the open tab's details button and each tab's hover preview show what a person
// wrote first in the tab, also after a rename. An agent's thread tabs had them; a channel's did not.
import type { ChannelSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ChannelTabs } from "./ChannelTabs";
import { ChannelsControllerProvider } from "./channels-context";
import { createChannelsController } from "./channels-controller";
import type { ChannelsPort } from "./channels-port";

const CHANNEL = "channel-tabs";
const at = "2026-10-31T10:00:00.000Z";

const channel: ChannelSummary = {
  id: CHANNEL,
  name: "naia - deploys",
  title: "",
  instructions: "",
  members: [],
  leadAgentId: null,
  archived: false,
  revision: 0,
  createdAt: at,
  unreadCount: 0,
  activeTasks: 0,
  lastMessage: null,
  topics: [
    {
      id: "old",
      channelId: CHANNEL,
      name: "Main",
      createdAt: at,
      revision: 0,
      messageCount: 2,
      firstMessage: "Suba a versão nova",
      lastUserMessage: "Suba a versão nova",
    },
    {
      id: "new",
      channelId: CHANNEL,
      name: "Renomeada",
      createdAt: at,
      revision: 3,
      messageCount: 4,
      firstMessage: "Ajuste o **filtro** da busca\n\nE confira os logs",
      lastUserMessage: "Agora o botão",
    },
    { id: "empty", channelId: CHANNEL, name: "Aba 3", createdAt: at, revision: 0, messageCount: 0 },
  ],
};

/** A call the tabs do not make. */
const unused = () => Promise.reject(new Error("The tabs do not call this."));

/** A host with the one channel, open on the tab "new". */
const port: ChannelsPort = {
  agent: {
    listChannels: async () => [channel],
    readChannel: async () => ({
      channel,
      topicId: "new",
      messages: [],
      tasks: [],
      olderCursor: null,
      throughSequence: 0,
    }),
    channelCommand: async () => channel,
    chooseAttachments: unused,
    openAttachment: unused,
    respondToApproval: unused,
    respondToBrowserSecret: unused,
    respondToBrowserTakeover: unused,
    respondToPrompt: unused,
    listChannelMemories: unused,
    createChannelMemory: unused,
    updateChannelMemory: unused,
    deleteChannelMemory: unused,
    clearChannelMemories: unused,
    listChannelRoutines: unused,
    listChannelRoutineRuns: unused,
    createChannelRoutine: unused,
    updateChannelRoutine: unused,
    deleteChannelRoutine: unused,
    testChannelRoutine: unused,
    onEvent: () => () => {},
  },
  browser: { capturePreview: unused },
  openUrl: unused,
  fileActions: "native",
};

async function mount() {
  render(() => {
    const controller = createChannelsController({
      port: () => port,
      agents: () => [],
      scopeKey: () => "reader",
      readSelection: () => CHANNEL,
      writeSelection: () => {},
      supported: () => true,
      deletionSupported: () => true,
      beforeOpen: () => {},
      canMarkRead: () => true,
    });
    return (
      <ChannelsControllerProvider controller={controller}>
        <ChannelTabs channelId={CHANNEL} archived={false} />
      </ChannelsControllerProvider>
    );
  });
  await screen.findByText("Renomeada");
  // The tab "new" opens when the read of the channel arrives.
  await screen.findByRole("button", { name: "Thread details" });
}

const tab = (name: string) => screen.getByRole("button", { name });

describe("the tabs of a channel", () => {
  it("shows the details button only on the open tab, before its name", async () => {
    await mount();
    const buttons = screen.getAllByRole("button", { name: "Thread details" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.nextElementSibling).toBe(tab("Renomeada"));
    expect(tab("Renomeada").getAttribute("aria-current")).toBe("true");
  });

  it("opens the details with the first message that a person sent, after a rename", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Thread details" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Renomeada" })).toBeTruthy();
    expect(dialog.textContent).toContain("Ajuste o filtro da busca");
    expect(dialog.textContent).toContain("E confira os logs");
    expect(dialog.textContent).toContain("Agora o botão");
  });

  it("previews the first message when the pointer stays on a tab", async () => {
    await mount();
    await fireEvent.pointerEnter(tab("Main"), { pointerType: "mouse" });
    await fireEvent.pointerMove(tab("Main"), { pointerType: "mouse" });
    const card = await screen.findByRole("tooltip", {}, { timeout: 2_000 });
    expect(card.textContent).toContain("Suba a versão nova");
  });

  it("has no details button on an open tab where nobody wrote", async () => {
    await mount();
    await fireEvent.click(tab("Aba 3"));
    await vi.waitFor(() => expect(tab("Aba 3").getAttribute("aria-current")).toBe("true"));
    expect(screen.queryByRole("button", { name: "Thread details" })).toBeNull();
  });
});
