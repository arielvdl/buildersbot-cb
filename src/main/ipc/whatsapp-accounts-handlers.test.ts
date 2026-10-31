// @vitest-environment node

import type {
  WhatsAppAccountActionInput,
  WhatsAppAccountAddInput,
  WhatsAppAccountsResult,
  WhatsAppAccountsSnapshot,
  WhatsAppLinkInput,
} from "@openbot/contracts/ipc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsAppAccountsIpcHandlers } from "./whatsapp-accounts-handlers";

// Same reason as define-ipc-group.test.ts: electron cannot be imported outside an Electron process.
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED = "openbot-app://app/index.html";
const SNAPSHOT: WhatsAppAccountsSnapshot = { status: "ready", accounts: [], serverRunning: false };
const OK: WhatsAppAccountsResult = { ok: true, snapshot: SNAPSHOT, notice: null };

function register() {
  const added: WhatsAppAccountAddInput[] = [];
  const actions: WhatsAppAccountActionInput[] = [];
  const links: WhatsAppLinkInput[] = [];
  const { whatsappAccounts } = whatsAppAccountsIpcHandlers({
    accounts: {
      list: async () => SNAPSHOT,
      add: async (input) => {
        added.push(input);
        return OK;
      },
      act: async (input) => {
        actions.push(input);
        return OK;
      },
      startLink: async (input) => {
        links.push(input);
        return { phase: "starting" };
      },
      linkState: () => null,
      cancelLink: async () => undefined,
    },
  });
  for (const [name, bind] of Object.entries(whatsappAccounts)) bind(`whatsappAccounts:${name}`);
  const call = (name: string, payload?: unknown, url = TRUSTED) => {
    const listener = registrations.get(`whatsappAccounts:${name}`);
    if (!listener) throw new Error(`No handler for ${name}.`);
    return listener({ senderFrame: { url }, sender: { id: 1 } }, payload);
  };
  return { added, actions, links, call };
}

beforeEach(() => registrations.clear());

describe("WhatsApp accounts handlers", () => {
  it("rejects a renderer outside the app before it reads the payload", () => {
    const { added, call } = register();
    expect(() => call("add", { id: "sofia", name: "Sofia", phone: null }, "https://evil.example/")).toThrow(
      "untrusted renderer",
    );
    expect(() => call("add", { id: "-rf" }, "https://evil.example/")).toThrow("untrusted renderer");
    expect(() => call("list", undefined, "https://evil.example/")).toThrow("untrusted renderer");
    expect(added).toEqual([]);
  });

  it("refuses an account id that wazap would not take or that reads as a flag", () => {
    const { added, call } = register();
    for (const id of ["-rf", "--data-dir=/tmp", "Sofia", "a".repeat(33), "sofia; rm -rf ~", "", "sofía", 7]) {
      expect(() => call("add", { id, name: "Sofia", phone: null })).toThrow("account id is invalid");
    }
    expect(added).toEqual([]);
  });

  it("refuses a nickname with a control character, an empty one and a long one", () => {
    const { added, call } = register();
    for (const name of ["", "   ", "Sofia\nRaquel", "Sofia\u0000", "a".repeat(65), 12]) {
      expect(() => call("add", { id: "sofia", name, phone: null })).toThrow("name is invalid");
    }
    expect(added).toEqual([]);
  });

  it("keeps quotes, semicolons, dashes and unicode in a nickname as one value", async () => {
    const { added, call } = register();
    await call("add", { id: "oliver", name: '  --yes "Oliver"; rm -rf ~ 😀 ', phone: "+15550100" });
    expect(added).toEqual([{ id: "oliver", name: '--yes "Oliver"; rm -rf ~ 😀', phone: "+15550100" }]);
  });

  it("takes only a number in E.164", () => {
    const { added, call } = register();
    for (const phone of ["15550100", "+0123456789", "+1555", "+1 555 0100", "+1555010012345678", "--phone=x"]) {
      expect(() => call("add", { id: "sofia", name: "Sofia", phone })).toThrow("number is invalid");
    }
    expect(added).toEqual([]);
  });

  it("refuses an unlink or a remove without the confirmation of the same account", async () => {
    const { actions, call } = register();
    expect(() => call("act", { action: "remove", id: "default" })).toThrow("needs a confirmation");
    expect(() => call("act", { action: "remove", id: "default", confirm: "sofia" })).toThrow("needs a confirmation");
    expect(() => call("act", { action: "unlink", id: "default", confirm: true })).toThrow("needs a confirmation");
    expect(() => call("act", { action: "format", id: "default" })).toThrow("action is invalid");
    expect(actions).toEqual([]);
    await call("act", { action: "remove", id: "default", confirm: "default" });
    await call("act", { action: "disable", id: "default", confirm: "ignored" });
    expect(actions).toEqual([
      { action: "remove", id: "default", confirm: "default" },
      { action: "disable", id: "default" },
    ]);
  });

  it("needs the number for a pairing code and not for a QR code", async () => {
    const { links, call } = register();
    expect(() => call("startLink", { id: "sofia", method: "code", phone: null })).toThrow("number is invalid");
    expect(() => call("startLink", { id: "sofia", method: "sms", phone: "+15550100" })).toThrow("request is invalid");
    await call("startLink", { id: "sofia", method: "qr" });
    await call("startLink", { id: "sofia", method: "code", phone: "+15550100" });
    expect(links).toEqual([
      { id: "sofia", method: "qr", phone: null },
      { id: "sofia", method: "code", phone: "+15550100" },
    ]);
  });

  it("checks the account id of a pairing read and a cancel", () => {
    const { call } = register();
    expect(() => call("linkState", "../default")).toThrow("account id is invalid");
    expect(() => call("cancelLink", { id: "sofia" })).toThrow("account id is invalid");
    expect(call("linkState", "sofia")).toBeNull();
  });
});
