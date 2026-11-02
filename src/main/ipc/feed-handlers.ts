// The feed page: a full read and the watch switch. Only the main window and the chat windows show the
// page, so the Dynamic Island and the browser dock overlay, which share their origin, are refused
// before their payload is read.

import {
  type FeedSnapshotInput,
  type FeedWatchInput,
  IPC_ENDPOINTS,
  isFeedSnapshotInput,
  isFeedWatchInput,
} from "@openbot/contracts/ipc";
import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { FeedService } from "../feed/feed-service";
import { sendToRenderer } from "../renderer-ipc";
import { authorizedHandler, type IpcGroupHandlers } from "./define-ipc-group";
import { optionalPayload } from "./validation";

export interface FeedIpcDependencies {
  feed: FeedService;
  /** The main window and the chat windows. */
  appWindows: () => readonly BrowserWindow[];
}

function parseFeedSnapshotInput(input: unknown): FeedSnapshotInput {
  if (!isFeedSnapshotInput(input)) throw new Error("The feed read is invalid.");
  return input.limit === undefined ? {} : { limit: input.limit };
}

function parseFeedWatchInput(input: unknown): FeedWatchInput {
  if (!isFeedWatchInput(input)) throw new Error("The feed watch state is required.");
  return { watching: input.watching };
}

export function feedIpcHandlers({ feed, appWindows }: FeedIpcDependencies): Pick<IpcGroupHandlers, "feed"> {
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
    },
  };
}
