import type { ChannelSummary } from "@openbot/contracts/ipc";
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ChannelTabOverview } from "./ChannelTabOverview";
import { type ChannelsController, ChannelsControllerProvider } from "./channels-context";

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

function mount() {
  const setTopic = vi.fn(() => Promise.resolve());
  const controller = {
    state: { channels: [channel], topicId: "new", page: null, loading: false, error: null },
    setTopic,
  } as unknown as ChannelsController;
  const result = render(() => (
    <ChannelsControllerProvider controller={controller}>
      <ChannelTabOverview channelId={CHANNEL} onClose={() => {}} restoreFocus={() => {}} />
    </ChannelsControllerProvider>
  ));
  return { ...result, setTopic };
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll(".channel-tab-card-name")].map((element) => element.textContent);

describe("the list of a channel's tabs", () => {
  it("shows the running tab first and each tab's age", () => {
    const { container } = mount();
    expect(names(container)).toEqual(["Meio", "Vídeo novo", "Antigo"]);
    expect([...container.querySelectorAll(".channel-tab-card-age")].map((element) => element.textContent)).toEqual([
      "3 min ago",
      "2 min ago",
      "1 h ago",
    ]);
  });

  it("changes the sort to the most recent", async () => {
    const { container, getByText } = mount();
    await fireEvent.click(getByText("Most recent"));
    expect(names(container)).toEqual(["Vídeo novo", "Meio", "Antigo"]);
  });

  it("searches the tabs without case or accents", async () => {
    const { container, getByLabelText } = mount();
    const search = getByLabelText("Search tabs") as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "VIDEO" } });
    expect(names(container)).toEqual(["Vídeo novo"]);
  });

  it("opens a tab when its card is clicked", async () => {
    const { container, setTopic } = mount();
    await fireEvent.click(container.querySelectorAll(".channel-tab-card")[0] as HTMLElement);
    expect(setTopic).toHaveBeenCalledWith("mid");
  });

  it("pins a tab to the front, and unpins it", async () => {
    window.localStorage.clear();
    const { container, getAllByLabelText } = mount();
    await fireEvent.click(getAllByLabelText("Pin tab")[2] as HTMLElement);
    expect(names(container)).toEqual(["Antigo", "Meio", "Vídeo novo"]);
    await fireEvent.click(getAllByLabelText("Unpin tab")[0] as HTMLElement);
    expect(names(container)).toEqual(["Meio", "Vídeo novo", "Antigo"]);
  });
});
