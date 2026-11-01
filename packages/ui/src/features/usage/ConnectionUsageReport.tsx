import type { HubConnectionOrgUsage, HubConnectionUsageRow, HubConnectionUsageView } from "@openbot/contracts/ipc";
import { Badge } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { formatConnectionMoney } from "../billing/money";

/** The state of a row, when it needs a word: 80 % of the cap used, or the cap reached. */
function StateBadge(props: { row: HubConnectionUsageRow }) {
  const { t } = useText();
  return (
    <Show when={props.row.state !== "ok"}>
      <Badge variant={props.row.state === "reached" ? "destructive-light" : "warning-light"}>
        {props.row.state === "reached" ? t("usage.connections.reached") : t("usage.connections.warning")}
      </Badge>
    </Show>
  );
}

function ConnectionRow(props: { org: HubConnectionOrgUsage; row: HubConnectionUsageRow }) {
  const { t, format } = useText();
  const money = (micros: number) => formatConnectionMoney(format, micros, props.org.currency);
  const left = () => {
    const cap = props.row.cap;
    return cap?.kind === "limited"
      ? t("usage.connections.left", { amount: money(props.row.effectiveAvailableMicros), cap: money(cap.amountMicros) })
      : t("usage.connections.leftNoCap", { amount: money(props.row.effectiveAvailableMicros) });
  };
  const platforms = () => [...props.row.platforms].sort((a, b) => b.settledMicros - a.settledMicros);
  return (
    <div class="connection-usage-row">
      <div class="agent-usage-provider-heading">
        <span>
          {props.row.name}
          <StateBadge row={props.row} />
        </span>
        <strong>{money(props.row.settledMicros)}</strong>
      </div>
      <p class="agent-usage-secondary connection-usage-note">
        {t("usage.connections.calls", { count: props.row.calls })} · {left()}
      </p>
      <Show
        when={platforms().length > 0}
        fallback={<p class="agent-usage-secondary connection-usage-note">{t("usage.connections.noPlatforms")}</p>}
      >
        <div class="agent-usage-table">
          <table>
            <caption class="sr-only">{t("usage.connections.byPlatform", { connection: props.row.name })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("usage.connections.platform")}</th>
                <th scope="col">{t("usage.connections.charged")}</th>
                <th scope="col">{t("usage.connections.callsColumn")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={platforms()}>
                {(platform) => (
                  <tr>
                    <th scope="row">{platform.platform}</th>
                    <td>{money(platform.settledMicros)}</td>
                    <td>{format.number(platform.calls)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

/**
 * Usage › Connections: what Cultura Builder charged the person for paid connections this month, by
 * organization and by platform. It is apart from the model estimate in USD: these are real charges in
 * the organization's currency, so the two are never summed.
 */
export function ConnectionUsageReport(props: { view: HubConnectionUsageView }) {
  const { t, format } = useText();
  return (
    <section class="connection-usage" aria-labelledby="connection-usage-title">
      <div class="agent-usage-section-header">
        <h3 id="connection-usage-title">{t("usage.connections.title")}</h3>
      </div>
      <p class="agent-usage-secondary connection-usage-note">{t("usage.connections.description")}</p>
      <Show
        when={props.view.status === "ready"}
        fallback={
          <p class="agent-usage-secondary connection-usage-note" role="status">
            {t("usage.connections.unavailable")}
          </p>
        }
      >
        <Show
          when={props.view.orgs.length > 0}
          fallback={
            <p class="agent-usage-secondary connection-usage-note" role="status">
              {t("usage.connections.empty")}
            </p>
          }
        >
          <For each={props.view.orgs} keyed={(org) => org.orgId}>
            {(org) => (
              <div class="connection-usage-org">
                <h4 class="connection-usage-org-title">
                  {org().personal
                    ? t("usage.connections.personal")
                    : t("usage.connections.paidBy", { org: org().orgName || org().orgId })}
                </h4>
                <p class="agent-usage-secondary connection-usage-note">
                  {t("usage.connections.renews", {
                    date: format.date(new Date(org().resetsAt), { dateStyle: "medium" }),
                  })}
                </p>
                <Show
                  when={org().connections.length > 0}
                  fallback={<p class="agent-usage-secondary connection-usage-note">{t("usage.connections.empty")}</p>}
                >
                  <For each={org().connections} keyed={(row) => row.id}>
                    {(row) => <ConnectionRow org={org()} row={row()} />}
                  </For>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </section>
  );
}
