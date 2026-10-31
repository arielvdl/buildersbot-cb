// The preview's wazap: two accounts, a pairing code that links on the third read, and no network.

import type {
  BuildersBotDesktopApi,
  WhatsAppAccount,
  WhatsAppAccountsSnapshot,
  WhatsAppLinkState,
} from "@openbot/contracts/ipc";
import { maskWhatsAppNumber } from "@openbot/contracts/ipc";

export function createMockWhatsAppAccounts(): BuildersBotDesktopApi["whatsappAccounts"] {
  let accounts: WhatsAppAccount[] = [
    {
      id: "default",
      name: "default",
      number: maskWhatsAppNumber("15550100"),
      formerNumber: null,
      unlinkedHistory: false,
      state: "linked",
      isDefault: true,
      readOnly: false,
      messages: 1280,
    },
    {
      id: "empresa",
      name: "Empresa",
      number: null,
      formerNumber: null,
      unlinkedHistory: false,
      state: "not-linked",
      isDefault: false,
      readOnly: true,
      messages: null,
    },
  ];
  const links = new Map<string, { state: WhatsAppLinkState; reads: number }>();
  const snapshot = (): WhatsAppAccountsSnapshot => ({
    status: "ready",
    serverRunning: true,
    globalReadOnly: false,
    accounts: accounts.map((account) => ({ ...account })),
  });
  const change = (id: string, update: (account: WhatsAppAccount) => WhatsAppAccount) => {
    accounts = accounts.map((account) => (account.id === id ? update(account) : account));
  };

  return {
    list: async () => snapshot(),
    add: async (input) => {
      if (accounts.some((account) => account.id === input.id))
        return { ok: false, error: "id-taken", snapshot: snapshot() };
      accounts = [
        ...accounts,
        {
          id: input.id,
          name: input.name,
          number: null,
          formerNumber: null,
          unlinkedHistory: false,
          state: "not-linked",
          isDefault: false,
          readOnly: false,
          messages: null,
        },
      ];
      return { ok: true, snapshot: snapshot(), notice: null };
    },
    act: async (input) => {
      if (!accounts.some((account) => account.id === input.id)) {
        return { ok: false, error: "account-not-found", snapshot: snapshot() };
      }
      switch (input.action) {
        case "enable":
          change(input.id, (account) => ({ ...account, state: account.number ? "linked" : "not-linked" }));
          break;
        case "disable":
          change(input.id, (account) => ({ ...account, state: "disabled" }));
          break;
        case "default":
          accounts = accounts.map((account) => ({ ...account, isDefault: account.id === input.id }));
          break;
        case "read-only":
        case "writable":
          change(input.id, (account) => ({ ...account, readOnly: input.action === "read-only" }));
          return { ok: true, snapshot: snapshot(), notice: "restart-needed" };
        case "unlink":
          change(input.id, (account) => ({
            ...account,
            number: null,
            formerNumber: account.number,
            unlinkedHistory: account.number !== null,
            state: "not-linked",
          }));
          break;
        case "remove":
          if (accounts.length === 1) return { ok: false, error: "last-account", snapshot: snapshot() };
          accounts = accounts.filter((account) => account.id !== input.id);
          // As wazap does: the first account left becomes the default.
          if (!accounts.some((account) => account.isDefault))
            accounts = accounts.map((account, index) => ({ ...account, isDefault: index === 0 }));
          break;
      }
      return { ok: true, snapshot: snapshot(), notice: null };
    },
    startLink: async (input) => {
      const state: WhatsAppLinkState =
        input.method === "qr"
          ? { phase: "failed", error: "qr-needs-free-folder" }
          : { phase: "code", code: "ABCD-EFGH", expiresAt: Date.now() + 120_000 };
      links.set(input.id, { state, reads: 0 });
      change(input.id, (account) => (state.phase === "code" ? { ...account, state: "linking" } : account));
      return state;
    },
    linkState: async (id) => {
      const link = links.get(id);
      if (!link) return null;
      link.reads += 1;
      if (link.state.phase === "code" && link.reads >= 3) {
        link.state = { phase: "linked", otherNumber: false };
        change(id, (account) => ({ ...account, state: "linked", number: maskWhatsAppNumber("15550199"), messages: 0 }));
      }
      return link.state;
    },
    cancelLink: async (id) => {
      links.delete(id);
      change(id, (account) => (account.state === "linking" ? { ...account, state: "not-linked" } : account));
    },
  };
}
