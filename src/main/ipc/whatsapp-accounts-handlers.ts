// The WhatsApp accounts of the wazap server on this computer.

import type { WhatsAppAccounts } from "../whatsapp-accounts";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
  parseWhatsAppAccountAction,
  parseWhatsAppAccountAdd,
  parseWhatsAppAccountId,
  parseWhatsAppLink,
} from "./whatsapp-accounts-inputs";

export interface WhatsAppAccountsIpcDependencies {
  accounts: Pick<WhatsAppAccounts, "list" | "add" | "act" | "startLink" | "linkState" | "cancelLink">;
}

/**
 * The page names an account, a nickname, a number and an action. The command, its arguments and
 * the data folder stay in main.
 */
export function whatsAppAccountsIpcHandlers({
  accounts,
}: WhatsAppAccountsIpcDependencies): Pick<IpcGroupHandlers, "whatsappAccounts"> {
  return {
    whatsappAccounts: {
      list: handler(() => accounts.list()),
      add: payloadHandler(parseWhatsAppAccountAdd, (input) => accounts.add(input)),
      act: payloadHandler(parseWhatsAppAccountAction, (input) => accounts.act(input)),
      startLink: payloadHandler(parseWhatsAppLink, (input) => accounts.startLink(input)),
      linkState: payloadHandler(parseWhatsAppAccountId, (id) => accounts.linkState(id)),
      cancelLink: payloadHandler(parseWhatsAppAccountId, (id) => accounts.cancelLink(id)),
    },
  };
}
