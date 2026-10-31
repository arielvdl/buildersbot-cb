// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  decodeOptionalWhatsAppLinkState,
  decodeWhatsAppAccountsResult,
  decodeWhatsAppAccountsSnapshot,
  decodeWhatsAppLinkState,
} from "./whatsapp-accounts-decoding";

const ACCOUNT = {
  id: "default",
  name: "default",
  number: "•••• 0100",
  formerNumber: null,
  state: "linked",
  isDefault: true,
  readOnly: false,
  messages: 1280,
};

const QR = Array.from({ length: 21 }, (_, row) => (row % 2 === 0 ? "10".repeat(10) + "1" : "01".repeat(10) + "0"));

describe("WhatsApp accounts decoding", () => {
  it("passes a snapshot that main sends", () => {
    const snapshot = { status: "ready", serverRunning: true, accounts: [ACCOUNT] };
    expect(decodeWhatsAppAccountsSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeWhatsAppAccountsSnapshot({ status: "unavailable", error: "timeout" })).toEqual({
      status: "unavailable",
      error: "timeout",
    });
  });

  it("refuses a whole number, so a page never reads one", () => {
    for (const number of ["+15550100", "15550100", "•••• 15550100", "+1 •••• 0100"]) {
      expect(() =>
        decodeWhatsAppAccountsSnapshot({ status: "ready", serverRunning: false, accounts: [{ ...ACCOUNT, number }] }),
      ).toThrow("Invalid WhatsApp accounts answer.");
    }
    expect(() =>
      decodeWhatsAppAccountsSnapshot({
        status: "ready",
        serverRunning: false,
        accounts: [{ ...ACCOUNT, formerNumber: "+15550100" }],
      }),
    ).toThrow("Invalid WhatsApp accounts answer.");
  });

  it("refuses an unknown state, an id wazap would not make and a bad count", () => {
    const bad = [
      { ...ACCOUNT, state: "banned" },
      { ...ACCOUNT, id: "../default" },
      { ...ACCOUNT, messages: -1 },
      { ...ACCOUNT, messages: 1.5 },
      { ...ACCOUNT, name: "" },
    ];
    for (const account of bad) {
      expect(() =>
        decodeWhatsAppAccountsSnapshot({ status: "ready", serverRunning: false, accounts: [account] }),
      ).toThrow("Invalid WhatsApp accounts answer.");
    }
    expect(() => decodeWhatsAppAccountsSnapshot({ status: "unavailable", error: "wazap said no" })).toThrow(
      "Invalid WhatsApp accounts answer.",
    );
  });

  it("decodes a result with its notice or its error code, never free text", () => {
    const snapshot = { status: "ready", serverRunning: false, accounts: [ACCOUNT] };
    expect(decodeWhatsAppAccountsResult({ ok: true, snapshot, notice: "restart-needed" })).toEqual({
      ok: true,
      snapshot,
      notice: "restart-needed",
    });
    expect(decodeWhatsAppAccountsResult({ ok: false, error: "owner-mismatch", snapshot: null })).toEqual({
      ok: false,
      error: "owner-mismatch",
      snapshot: null,
    });
    expect(() => decodeWhatsAppAccountsResult({ ok: false, error: 'No account "sofia"', snapshot: null })).toThrow(
      "Invalid WhatsApp accounts answer.",
    );
  });

  it("checks the pairing code and the QR rows", () => {
    expect(decodeWhatsAppLinkState({ phase: "code", code: "ABCD-EFGH", expiresAt: 1 })).toEqual({
      phase: "code",
      code: "ABCD-EFGH",
      expiresAt: 1,
    });
    expect(decodeWhatsAppLinkState({ phase: "qr", rows: QR, expiresAt: 1 })).toEqual({
      phase: "qr",
      rows: QR,
      expiresAt: 1,
    });
    expect(() => decodeWhatsAppLinkState({ phase: "code", code: "<img src=x>", expiresAt: 1 })).toThrow();
    expect(() => decodeWhatsAppLinkState({ phase: "code", code: "ABCD-EFGH", expiresAt: "soon" })).toThrow();
    expect(() => decodeWhatsAppLinkState({ phase: "qr", rows: QR.slice(1), expiresAt: 1 })).toThrow();
    expect(() =>
      decodeWhatsAppLinkState({ phase: "qr", rows: [...QR.slice(1), "2".repeat(21)], expiresAt: 1 }),
    ).toThrow();
    expect(() => decodeWhatsAppLinkState({ phase: "failed", error: "boom" })).toThrow();
    expect(decodeOptionalWhatsAppLinkState(null)).toBeNull();
  });
});
