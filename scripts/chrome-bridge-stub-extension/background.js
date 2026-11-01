// The service worker of the stub extension (protocol smoke only). It connects to the E2E Native
// Messaging host and runs `StubExtension`; the welcome page shows the words and sends the person's tap.
import { generateChannelKey, randomBase64Url } from "../../packages/contracts/src/chrome-bridge/channel";
import { NATIVE_HOST_NAMES } from "../../packages/contracts/src/chrome-bridge/protocol";
import { StubExtension } from "./stub-core";

const keyReady = generateChannelKey(false);
const installId = randomBase64Url(16);
const disconnects = [];
let stub = null;
let port = null;
let pinned = null;

async function connect() {
  if (port) return;
  const staticKey = await keyReady;
  const current = chrome.runtime.connectNative(NATIVE_HOST_NAMES.e2e);
  port = current;
  const version = /Chrome\/([\d.]+)/u.exec(navigator.userAgent)?.[1] ?? "0";
  stub = new StubExtension({
    send: (frame) => current.postMessage(frame),
    disconnect: () => current.disconnect(),
    staticKey,
    installId,
    browser: { brand: "chrome-for-testing", version },
    pinnedAppKey: pinned,
    evaluateDelayMs: 5,
    onChange: () => {
      if (stub?.view.pinnedAppKey) pinned = stub.view.pinnedAppKey;
    },
  });
  const own = stub;
  current.onMessage.addListener((frame) => void own.receive(frame));
  current.onDisconnect.addListener(() => {
    disconnects.push(chrome.runtime.lastError?.message ?? "disconnected");
    if (port === current) port = null;
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only this extension's own pages; `externally_connectable` is empty, so no page or extension else.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;
  if (message?.type === "state") {
    reply({ view: stub?.view ?? null, installId, disconnects, connected: port !== null });
    return;
  }
  if (message?.type === "choose" && Number.isInteger(message.index)) {
    void stub?.choose(message.index).then(() => reply({ ok: true }));
    return true;
  }
  if (message?.type === "connect") {
    void connect().then(() => reply({ ok: true }));
    return true;
  }
});

void connect();
