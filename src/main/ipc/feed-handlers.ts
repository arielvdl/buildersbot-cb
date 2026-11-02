// The feed page: a full read, the watch switch and the actions on the cards. Only the main window and
// the chat windows show the page, so the Dynamic Island and the browser dock overlay, which share their
// origin, are refused before their payload is read. An action names cards by id only; `FeedActions`
// checks each card again and calls the operation of the conversation or of the load panel.

import {
  type FeedActionInput,
  type FeedSnapshotInput,
  type FeedWatchInput,
  IPC_ENDPOINTS,
  isFeedActionInput,
  isFeedSnapshotInput,
  isFeedWatchInput,
} from "@openbot/contracts/ipc";
import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { FeedActions } from "../feed/feed-actions";
import type { FeedService } from "../feed/feed-service";
import { sendToRenderer } from "../renderer-ipc";
import { authorizedHandler, type IpcGroupHandlers } from "./define-ipc-group";
import { optionalPayload } from "./validation";

export interface FeedIpcDependencies {
  feed: FeedService;
  actions: FeedActions;
  /** The main window and the chat windows. */
  appWindows: () => readonly BrowserWindow[];
}

function parseFeedSnapshotInput(input: unknown): FeedSnapshotInput {
  if (!isFeedSnapshotInput(input)) throw new Error("The feed read is invalid.");
  return input.limit === undefined ? {} : { limit: input.limit };
}

/** A copy with the fields of its shape only, so nothing else reaches the actions. */
function parseFeedActionInput(input: unknown): FeedActionInput {
  if (!isFeedActionInput(input)) throw new Error("The feed action is invalid.");
  switch (input.action) {
    case "approve":
      return {
        v: input.v,
        action: input.action,
        itemId: input.itemId,
        requestId: input.requestId,
        ...(input.confirmed ? { confirmed: true as const } : {}),
      };
    case "deny":
      return { v: input.v, action: input.action, itemId: input.itemId, requestId: input.requestId };
    case "answer":
      return "choice" in input
        ? { v: input.v, action: input.action, itemId: input.itemId, requestId: input.requestId, choice: input.choice }
        : { v: input.v, action: input.action, itemId: input.itemId, requestId: input.requestId, text: input.text };
    case "stop":
      return { v: input.v, action: input.action, itemId: input.itemId, startedAt: input.startedAt };
    case "resume":
      return { v: input.v, action: input.action, itemIds: [...input.itemIds] };
    case "reassign":
      return {
        v: input.v,
        action: input.action,
        itemIds: [...input.itemIds],
        recipientAgentId: input.recipientAgentId,
      };
  }
}

function parseFeedWatchInput(input: unknown): FeedWatchInput {
  if (!isFeedWatchInput(input)) throw new Error("The feed watch state is required.");
  return { watching: input.watching };
}

export function feedIpcHandlers({ feed, actions, appWindows }: FeedIpcDependencies): Pick<IpcGroupHandlers, "feed"> {
  const fromAppWindow = (event: IpcMainInvokeEvent): void => {
    if (!appWindows().some((window) => !window.isDestroyed() && window.webContents.id === event.sender.id))
      throw new Error("Rejected feed IPC request outside an app window.");
  };
  /** The windows whose end already takes them off the feed. */
  const followed = new Set<number>();
  /** A window that reloads, navigates or closes stops watching; its new page asks again. */
  const follow = (contents: WebContents): void => {
    if (followed.has(contents.id)) return;
    followed.add(contents.id);
    const id = contents.id;
    const stop = (): void => feed.removeWatcher(id);
    contents.on("did-navigate", stop);
    contents.once("destroyed", () => {
      stop();
      followed.delete(id);
    });
  };
  return {
    feed: {
      getSnapshot: authorizedHandler(fromAppWindow, optionalPayload(parseFeedSnapshotInput), (_event, input) =>
        feed.snapshot(input?.limit),
      ),
      setWatching: authorizedHandler(fromAppWindow, parseFeedWatchInput, (event, input) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;
        follow(event.sender);
        feed.setWatching(
          { id: event.sender.id, send: (delta) => sendToRenderer(window, IPC_ENDPOINTS.feed.delta, delta) },
          input.watching,
        );
      }),
      act: authorizedHandler(fromAppWindow, parseFeedActionInput, (_event, input) => actions.act(input)),
    },
  };
}
