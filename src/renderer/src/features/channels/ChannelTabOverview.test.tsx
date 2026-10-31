import type { ChannelSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ChannelTabOverview } from "./ChannelTabOverview";
import { type ChannelsController, ChannelsControllerProvider } from "./channels-context";
import { createChannelsController } from "./channels-controller";
import type { ChannelsPort } from "./channels-port";

const CHANNEL = "channel-list";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const channel: ChannelSummary = {
  id: CHANNEL,
  name: "Launch",
  title: "",
  instructions: "",
  members: [],
  leadAgentId: null,
  archived: false,
  revision: 0,
  createdAt: ago(600),
  unreadCount: 0,
  activeTasks: 1,
  lastMessage: null,
  topics: [
    { id: "old", channelId: CHANNEL, name: "Antigo", createdAt: ago(600), updatedAt: ago(90), revision: 0 },
    { id: "new", channelId: CHANNEL, name: "Vídeo novo", createdAt: ago(300), updatedAt: ago(2), revision: 0 },
    {
      id: "mid",
      channelId: CHANNEL,
      name: "Meio",
      createdAt: ago(200),
      updatedAt: ago(3),
      revision: 0,
      activeTasks: 1,
    },
  ],
};

/** A call the list of tabs does not make. */
const unused = () => Promise.reject(new Error("The list of tabs does not call this."));

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

/** The tab names, in the order the list shows them. */
const TAB_NAME = /^(?:Antigo|Vídeo novo|Meio)$/u;
const names = () => screen.getAllByText(TAB_NAME).map((element) => element.textContent);
const ages = () => screen.getAllByText(/ ago$/u).map((element) => element.textContent);

/** The item at `index`, or a failure that names the missing one. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`There is no item ${index}.`);
  return item;
}

async function mount() {
  let controller: ChannelsController | undefined;
  render(() => {
    controller = createChannelsController({
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
        <ChannelTabOverview channelId={CHANNEL} onClose={() => {}} restoreFocus={() => {}} />
      </ChannelsControllerProvider>
    );
  });
  if (!controller) throw new Error("The controller was not created.");
  const setTopic = vi.spyOn(controller, "setTopic").mockResolvedValue(undefined);
  await screen.findByText("Meio");
  return { setTopic };
}

describe("the list of a channel's tabs", () => {
  it("shows the running tab first and each tab's age", async () => {
    await mount();
    expect(names()).toEqual(["Meio", "Vídeo novo", "Antigo"]);
    expect(ages()).toEqual(["3 min ago", "2 min ago", "1 h ago"]);
  });

  it("changes the sort to the most recent", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Most recent" }));
    expect(names()).toEqual(["Vídeo novo", "Meio", "Antigo"]);
  });

  it("searches the tabs without case or accents", async () => {
    await mount();
    await fireEvent.input(screen.getByRole("searchbox", { name: "Search tabs" }), { target: { value: "VIDEO" } });
    expect(names()).toEqual(["Vídeo novo"]);
  });

  it("opens a tab when its card is clicked", async () => {
    const { setTopic } = await mount();
    await fireEvent.click(screen.getByRole("button", { name: /^Meio/u }));
    expect(setTopic).toHaveBeenCalledWith("mid");
  });

  it("pins a tab to the front, and unpins it", async () => {
    window.localStorage.clear();
    await mount();
    await fireEvent.click(nth(screen.getAllByRole("button", { name: "Pin tab" }), 2));
    expect(names()).toEqual(["Antigo", "Meio", "Vídeo novo"]);
    await fireEvent.click(nth(screen.getAllByRole("button", { name: "Unpin tab" }), 0));
    expect(names()).toEqual(["Meio", "Vídeo novo", "Antigo"]);
  });
});
