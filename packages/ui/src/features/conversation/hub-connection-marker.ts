import type { HubConnectionChatEvent } from "@openbot/contracts/ipc";
import type { AppFormat, AppTranslate } from "@openbot/i18n";
import { formatConnectionMoney } from "../billing/money";

/**
 * The line of a Hub connection in a chat, in the reader's language: what a call cost and who paid,
 * the first call over 80 % of the cap, a call that the cap stopped, with the renewal date, or a charge
 * above the amount that the person approved.
 */
export function hubConnectionMarkerText(event: HubConnectionChatEvent, t: AppTranslate, format: AppFormat): string {
  const org = event.personal ? t("marketplace.connection.personalPlan") : event.orgName || event.orgId;
  const amount = formatConnectionMoney(format, event.amountMicros, event.currency);
  const renews = event.resetsAt
    ? ` ${t("chat.marker.connectionRenews", { date: format.date(new Date(event.resetsAt), { dateStyle: "medium" }) })}`
    : "";
  switch (event.kind) {
    case "paid":
      return t("chat.marker.connectionPaid", { endpoint: event.endpoint ?? event.connectionName, org, amount });
    case "warning":
      return `${t("chat.marker.connectionWarning", { connection: event.connectionName, org, amount })}${renews}`;
    case "limit":
      return `${t(event.scope === "org" ? "chat.marker.connectionLimitOrg" : "chat.marker.connectionLimitUser", {
        connection: event.connectionName,
        org,
      })}${renews}`;
    case "overcharged":
      return t("chat.marker.connectionOvercharged", {
        endpoint: event.endpoint ?? event.connectionName,
        org,
        amount,
        approved: formatConnectionMoney(format, event.approvedMicros ?? 0, event.currency),
      });
  }
}
