import type { Channel, ChannelCommand, ChannelPage, ChannelReadInput, ChannelSummary } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { type ChannelsController, createChannelsController } from "./channels-controller";
import type { ChannelsPort } from "./channels-port";

/*
 * The read a channel sends when a tab opens. Each tab has its own read cursor, but the sequence of a
 * message is counted across the channel, so a tab's newest message can be older than another tab's.
 */

const CHANNEL = "channel-reads";
const MAIN = `openbot-topic-${CHANNEL}`;
const SECOND = "openbot-topic-second";

const channel: Channel = {
  id: CHANNEL,
  name: "Reads",
  title: "",
  instructions: "",
  members: [],
  leadAgentId: null,
  archived: false,
  revision: 0,
  createdAt: "2026-10-29T00:00:00.000Z",
};

/** A call the controller does not make. */
const unused = () => Promise.reject(new Error("The channel controller does not call this."));

/** A host with two tabs. `newest` is the channel-wide sequence of each tab's newest message. */
function host() {
  const newest = new Map<string, number>([
    [MAIN, 5],
    [SECOND, 8],
  ]);
  /** The unread count of each tab in the channel list. */
  const unread = new Map<string, number>();
  const commands: ChannelCommand[] = [];
  /** The channels a `save` created, as the host holds them next to the first one. */
  const created = new Set<string>();
  const summary = (): ChannelSummary => ({
    ...channel,
    unreadCount: [...unread.values()].reduce((sum, count) => sum + count, 0),
    activeTasks: 0,
    lastMessage: null,
    topics: [...newest.keys()].map((id) => ({
      id,
      channelId: CHANNEL,
      name: id,
      createdAt: channel.createdAt,
      revision: 0,
      unreadCount: unread.get(id) ?? 0,
    })),
  });
  const port: ChannelsPort = {
    agent: {
      listChannels: async (): Promise<ChannelSummary[]> => [
        summary(),
        ...[...created].map(
          (id): ChannelSummary => ({
            ...summary(),
            id,
            topics: [
              { id: `openbot-topic-${id}`, channelId: id, name: "Main", createdAt: channel.createdAt, revision: 0 },
            ],
          }),
        ),
      ],
      readChannel: async (input: ChannelReadInput): Promise<ChannelPage> => {
        // The local host does not check the tab of a channel it reads, and answers an empty page.
        if (created.has(input.channelId))
          return {
            channel: { ...channel, id: input.channelId },
            topicId: input.topicId ?? `openbot-topic-${input.channelId}`,
            messages: [],
            tasks: [],
            olderCursor: null,
            throughSequence: 0,
          };
        const topicId = input.topicId ?? MAIN;
        const throughSequence = newest.get(topicId);
        if (throughSequence === undefined) throw new Error("The tab is not in this channel.");
        return { channel, topicId, messages: [], tasks: [], olderCursor: null, throughSequence };
      },
      channelCommand: async (command: ChannelCommand): Promise<Channel> => {
        commands.push(command);
        if (command.type === "save") created.add(command.channelId);
        if (command.type === "topic-delete") newest.delete(command.topicId);
        return channel;
      },
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
  /** The reads sent, as `tab:sequence`. */
  const reads = () =>
    commands.flatMap((command) =>
      command.type === "read" ? [`${command.topicId ?? "none"}:${command.throughSequence}`] : [],
    );
  return { newest, unread, port, reads };
}

async function mount(port: ChannelsPort): Promise<ChannelsController> {
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
    return null;
  });
  const opened = controller;
  if (!opened) throw new Error("The controller was not created.");
  await vi.waitFor(() => expect(opened.state.page?.topicId).toBe(MAIN));
  return opened;
}

/**
 * The repro of the QA run: Main gets a reply while the second tab is open, and a newer message is
 * then read in the second tab. Main's newest message is now older than the newest one read.
 */
async function readNewerInSecondTab(fake: ReturnType<typeof host>, channels: ChannelsController): Promise<void> {
  await channels.setTopic(SECOND);
  fake.newest.set(MAIN, 9);
  fake.newest.set(SECOND, 10);
  await channels.refresh();
  expect(fake.reads()).toEqual([`${MAIN}:5`, `${SECOND}:8`, `${SECOND}:10`]);
}

describe("the read a channel tab sends", () => {
  it("reads a tab whose newest message is older than one read in another tab", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    await readNewerInSecondTab(fake, channels);

    await channels.setTopic(MAIN);

    expect(channels.state.topicId).toBe(MAIN);
    expect(fake.reads().at(-1)).toBe(`${MAIN}:9`);
  });

  it("reads the first tab when the open one closes and the channel falls back to it", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    await readNewerInSecondTab(fake, channels);

    expect(await channels.deleteTopic(SECOND)).toBe(true);

    expect(channels.state.topicId).toBe(MAIN);
    expect(fake.reads().at(-1)).toBe(`${MAIN}:9`);
  });

  it("reads the first tab when the open one closes on another client", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    await readNewerInSecondTab(fake, channels);

    fake.newest.delete(SECOND);
    await channels.refresh();

    expect(channels.state.topicId).toBe(MAIN);
    expect(fake.reads().at(-1)).toBe(`${MAIN}:9`);
  });

  it("does not send a read again for a tab that has nothing newer", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    await readNewerInSecondTab(fake, channels);
    await channels.setTopic(MAIN);
    const sent = fake.reads().length;

    await channels.refresh();
    await channels.setTopic(SECOND);

    expect(fake.reads()).toHaveLength(sent);
  });

  it("marks every unread tab read, not only the first one", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    fake.newest.set(SECOND, 11);
    fake.unread.set(SECOND, 2);
    await channels.refresh();

    expect(await channels.markAllRead()).toBe(true);

    expect(fake.reads().at(-1)).toBe(`${SECOND}:11`);
  });
});

describe("the tab of a channel the reader creates", () => {
  it("opens the new channel on its first tab, not on the tab that was open", async () => {
    const fake = host();
    const channels = await mount(fake.port);
    await channels.setTopic(SECOND);
    channels.create();
    await vi.waitFor(() => expect(channels.state.editing).toBe("create"));

    await channels.command({
      type: "save",
      operationId: "create-1",
      channelId: "channel-new",
      draft: { name: "New", title: "", instructions: "", members: [], leadAgentId: null },
    });

    expect(channels.state.selectedId).toBe("channel-new");
    expect(channels.state.topicId).toBe("openbot-topic-channel-new");
  });
});
