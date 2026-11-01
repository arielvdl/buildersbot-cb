import type { HubAccessRequestKind, HubConnectionAccessView } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  Info,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  OctagonX,
  Progress,
  RefreshCw,
  SettingsSection,
  SwitchField,
  Text,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { formatConnectionMoney } from "../billing/money";
import { IntegrationPage } from "../settings/IntegrationLayout";
import { ConnectionRequestButton } from "./ConnectionRequestButton";
import { AppMark } from "./MarketplaceParts";
import {
  type ConnectionApp,
  canPayRow,
  capUsed,
  type MarketplaceConnections,
  shownAccess,
} from "./marketplace-connections";
import type { MarketplaceAppStatus } from "./marketplace-model";
import type { MarketplaceScope } from "./marketplace-view";

const STATUS_LABEL = {
  connected: "marketplace.connection.status.on",
  attention: "marketplace.app.attention",
  connecting: "marketplace.connection.status.on",
  idle: "marketplace.connection.status.off",
} as const satisfies Record<MarketplaceAppStatus, AppTextKey>;

/** Why a row cannot pay, in the person's words. Null when it can. */
function accessReason(row: HubConnectionAccessView): AppTextKey | null {
  if (row.org === "paused") return "marketplace.connection.access.paused";
  if (row.org === "revoked") return "marketplace.connection.access.revoked";
  if (row.org === "not_in_plan") return "marketplace.connection.access.notInPlan";
  if (row.org === "not_enabled") return "marketplace.connection.access.notEnabled";
  if (row.user === "not_allowed") return "marketplace.connection.access.notAllowed";
  if (row.user === "requested") return "marketplace.connection.access.requested";
  if (!row.consented) return "marketplace.connection.access.consent";
  return null;
}

/** The request that a row offers: access for a person who may not use it yet, more money at the cap. */
function requestKind(row: HubConnectionAccessView): HubAccessRequestKind | null {
  if (row.personal) return null;
  if (row.org === "not_enabled" || row.user === "not_allowed" || row.user === "requested") return "access";
  if (canPayRow(row) && row.state === "reached") return "more";
  return null;
}

/** The request button of one access row. */
function RequestButton(props: {
  connections: MarketplaceConnections;
  connectionId: string;
  row: HubConnectionAccessView;
  kind: HubAccessRequestKind;
}) {
  return (
    <ConnectionRequestButton
      kind={props.kind}
      sentAt={props.kind === "more" ? props.row.moreRequestedAt : props.row.requestedAt}
      request={() => props.connections.requestAccess(props.connectionId, props.row.orgId, props.kind)}
    />
  );
}

/** The person's cap: spent, reserved, what is left, the bar with the 80 % mark, and the renewal. */
function CapSection(props: { row: HubConnectionAccessView }) {
  const { t, format } = useText();
  const money = (micros: number) => formatConnectionMoney(format, micros, props.row.currency);
  const used = () => capUsed(props.row);
  const payer = () => (props.row.personal ? t("marketplace.connection.personalPlan") : props.row.orgName);
  const renews = () => format.date(new Date(props.row.resetsAt), { dateStyle: "medium" });
  return (
    <SettingsSection
      title={t("marketplace.connection.cap.title")}
      description={t("marketplace.connection.cap.paidBy", { org: payer() })}
    >
      <ItemGroup class="settings-modal-card">
        <div class="integration-card-body marketplace-connection-cap" data-state={props.row.state}>
          <Show
            when={props.row.cap.kind === "limited" ? props.row.cap.amountMicros : null}
            fallback={
              <Text as="p" variant="body-sm">
                {props.row.cap.kind === "unlimited" && props.row.cap.dailyMicros !== null
                  ? t("marketplace.connection.cap.unlimitedDaily", { amount: money(props.row.cap.dailyMicros) })
                  : t("marketplace.connection.cap.unlimited")}
              </Text>
            }
          >
            {(cap) => (
              <>
                <Text as="p" variant="body-sm" class="marketplace-connection-cap-line">
                  {t("marketplace.connection.cap.spent", {
                    spent: money(props.row.settledMicros),
                    cap: money(cap()),
                  })}
                </Text>
                <div class="marketplace-connection-cap-meter">
                  <Progress
                    class="marketplace-connection-cap-bar"
                    value={Math.round((used() ?? 0) * 100)}
                    minValue={0}
                    maxValue={100}
                    aria-label={t("marketplace.connection.cap.barLabel")}
                    getValueLabel={() =>
                      t("marketplace.connection.cap.barValue", {
                        percent: format.percent(used() ?? 0, { maximumFractionDigits: 0 }),
                        spent: money(props.row.settledMicros + props.row.reservedMicros),
                        cap: money(cap()),
                      })
                    }
                  />
                  {/* The mark where the Hub warns. A picture only: the state line below says it. */}
                  <span class="marketplace-connection-cap-mark" aria-hidden="true" />
                </div>
              </>
            )}
          </Show>
          <dl class="marketplace-connection-facts">
            <dt>{t("marketplace.connection.cap.available")}</dt>
            <dd>{money(props.row.effectiveAvailableMicros)}</dd>
            <Show when={props.row.reservedMicros > 0}>
              <dt>{t("marketplace.connection.cap.reserved")}</dt>
              <dd>{money(props.row.reservedMicros)}</dd>
            </Show>
            <dt>{t("marketplace.connection.cap.perCall")}</dt>
            <dd>{money(props.row.maxCostPerCallMicros)}</dd>
            <Show when={props.row.confirmAboveMicros}>
              {(above) => (
                <>
                  <dt>{t("marketplace.connection.cap.approval")}</dt>
                  <dd>{t("marketplace.connection.cap.approvalValue", { amount: money(above()) })}</dd>
                </>
              )}
            </Show>
            <dt>{t("marketplace.connection.cap.renews")}</dt>
            <dd>{renews()}</dd>
          </dl>
          <Show when={props.row.bindingScope !== "user"}>
            <Text as="p" variant="caption" tone="muted" class="integration-card-note">
              {t("marketplace.connection.cap.orgBinds")}
            </Text>
          </Show>
        </div>
      </ItemGroup>
    </SettingsSection>
  );
}

/** The alert of the cap: over 80 %, or reached, with "Ask the admin for more". */
function CapAlert(props: { connections: MarketplaceConnections; connectionId: string; row: HubConnectionAccessView }) {
  const { t, format } = useText();
  const renews = () => format.date(new Date(props.row.resetsAt), { dateStyle: "medium" });
  const left = () => formatConnectionMoney(format, props.row.effectiveAvailableMicros, props.row.currency);
  return (
    <Show when={props.row.state !== "ok" && canPayRow(props.row)}>
      <Alert tone={props.row.state === "reached" ? "danger" : "warning"} role="alert" report={false}>
        <AlertIcon>
          <Show when={props.row.state === "reached"} fallback={<TriangleAlert />}>
            <OctagonX />
          </Show>
        </AlertIcon>
        <AlertContent>
          <AlertTitle>
            {props.row.state === "reached"
              ? props.row.bindingScope === "user"
                ? t("marketplace.connection.reached.title")
                : t("marketplace.connection.reached.orgTitle")
              : t("marketplace.connection.warning.title")}
          </AlertTitle>
          <AlertDescription>
            {props.row.state === "reached"
              ? t("marketplace.connection.reached.description", { date: renews() })
              : t("marketplace.connection.warning.description", { amount: left(), date: renews() })}
          </AlertDescription>
        </AlertContent>
        <Show when={requestKind(props.row) === "more"}>
          <AlertActions>
            <RequestButton
              connections={props.connections}
              connectionId={props.connectionId}
              row={props.row}
              kind="more"
            />
          </AlertActions>
        </Show>
      </Alert>
    </Show>
  );
}

/** The page of one Hub connection: what it gives, the cap, who pays, the agents and where the data goes. */
export function MarketplaceConnectionPage(props: {
  scope: MarketplaceScope;
  app: ConnectionApp;
  connections: MarketplaceConnections;
}) {
  const { t, format } = useText();
  const view = () => props.app.connection;
  const row = () => shownAccess(view());
  const payingRows = () => view().access.filter(canPayRow);
  /** The cap shows for a row that pays, or that has spend in this period. */
  const capRow = () => {
    const access = row();
    return access && (canPayRow(access) || access.settledMicros > 0) ? access : undefined;
  };
  const categories = () => [...new Set(payingRows().flatMap((access) => access.categories))];
  const priceFrom = () => {
    const access = row();
    return access?.priceFromMicros ? formatConnectionMoney(format, access.priceFromMicros, access.currency) : null;
  };
  const approval = () => {
    const access = row();
    return access?.confirmAboveMicros
      ? formatConnectionMoney(format, access.confirmAboveMicros, access.currency)
      : null;
  };
  const vendor = () => view().dataPolicy.vendor;
  const region = () => {
    const code = view().dataPolicy.region.toLowerCase();
    return code === "us" ? t("marketplace.connection.data.regionUs") : view().dataPolicy.region;
  };
  const agentOn = (connectionsOff: readonly string[]) => !connectionsOff.includes(view().id);
  const busy = () => props.connections.busy(view().id);

  return (
    <IntegrationPage
      class="marketplace-connection-page"
      logo={<AppMark app={props.app} />}
      name={props.app.name}
      status={props.app.status}
      statusLabel={t(STATUS_LABEL[props.app.status])}
      subtitle={props.app.tagline}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={busy()}
          aria-label={t("marketplace.connection.refresh")}
          onClick={() => props.connections.refresh()}
        >
          <RefreshCw aria-hidden="true" />
          {t("marketplace.connection.refreshShort")}
        </Button>
      }
      alert={
        <>
          <Show when={!view().enabled}>
            <Alert tone="warning" role="alert" report={false}>
              <AlertIcon>
                <TriangleAlert />
              </AlertIcon>
              <AlertContent>
                <AlertTitle>{t("marketplace.connection.paused.title")}</AlertTitle>
                <AlertDescription>{t("marketplace.connection.paused.description")}</AlertDescription>
              </AlertContent>
            </Alert>
          </Show>
          <Show when={view().enabled && view().payer === "choose_org"}>
            <Alert tone="warning" role="alert" report={false}>
              <AlertIcon>
                <Info />
              </AlertIcon>
              <AlertContent>
                <AlertTitle>{t("marketplace.connection.choose.title")}</AlertTitle>
                <AlertDescription>{t("marketplace.connection.choose.description")}</AlertDescription>
              </AlertContent>
            </Alert>
          </Show>
          <Show when={view().enabled ? row() : undefined}>
            {(access) => <CapAlert connections={props.connections} connectionId={view().id} row={access()} />}
          </Show>
        </>
      }
    >
      <SettingsSection title={t("marketplace.connection.gives.title")}>
        <ItemGroup class="settings-modal-card">
          <div class="integration-card-body marketplace-connection-copy">
            <Text as="p" variant="body-sm">
              {view().description || t("marketplace.connection.gives.fallback")}
            </Text>
            <Text as="p" variant="body-sm">
              {t("marketplace.connection.gives.how")}
            </Text>
            <Show when={approval()}>
              {(amount) => (
                <Text as="p" variant="body-sm">
                  {t("marketplace.connection.gives.approval", { amount: amount() })}
                </Text>
              )}
            </Show>
            <Show when={view().itemsCount > 0 || priceFrom()}>
              <Text as="p" variant="body-sm" tone="muted">
                {[
                  view().itemsCount > 0 ? t("marketplace.connection.gives.count", { count: view().itemsCount }) : null,
                  priceFrom() ? t("marketplace.connection.gives.priceFrom", { amount: priceFrom() ?? "" }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Show>
            <Text as="p" variant="caption" tone="muted" class="integration-card-note">
              {t("marketplace.connection.gives.caveat")}
            </Text>
          </div>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection
        title={t("marketplace.connection.categories.title")}
        description={t("marketplace.connection.categories.description")}
      >
        <ItemGroup class="settings-modal-card">
          <div class="integration-card-body">
            <Show
              when={categories().length > 0}
              fallback={
                <Text as="p" variant="body-sm" tone="muted">
                  {t("marketplace.connection.categories.none")}
                </Text>
              }
            >
              <ul class="marketplace-connection-categories" aria-label={t("marketplace.connection.categories.title")}>
                <For each={categories()}>
                  {(name) => (
                    <li>
                      <Badge variant="secondary">{name}</Badge>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </ItemGroup>
      </SettingsSection>

      <Show when={capRow()}>{(access) => <CapSection row={access()} />}</Show>

      <SettingsSection
        title={t("marketplace.connection.payer.title")}
        description={t("marketplace.connection.payer.description")}
      >
        <ItemGroup class="settings-modal-card">
          <For
            each={view().access}
            fallback={
              <div class="integration-card-body">
                <Text as="p" variant="body-sm" tone="muted">
                  {t("marketplace.connection.payer.none")}
                </Text>
              </div>
            }
          >
            {(access) => {
              const name = () => (access.personal ? t("marketplace.connection.personalPlan") : access.orgName);
              const paying = () => view().payerOrgId === access.orgId;
              const reason = () => accessReason(access);
              const kind = () => (requestKind(access) === "access" ? ("access" as const) : null);
              return (
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>{name()}</ItemTitle>
                    <ItemDescription>
                      {reason()
                        ? t(reason() ?? "marketplace.connection.access.notEnabled")
                        : paying()
                          ? t("marketplace.connection.payer.paying")
                          : t("marketplace.connection.payer.canPay")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Show when={kind()}>
                      {(requested) => (
                        <RequestButton
                          connections={props.connections}
                          connectionId={view().id}
                          row={access}
                          kind={requested()}
                        />
                      )}
                    </Show>
                    <Show when={paying()}>
                      <Badge variant="success-light">{t("marketplace.connection.payer.badge")}</Badge>
                    </Show>
                    <Show when={!paying() && canPayRow(access) && payingRows().length > 1}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy()}
                        aria-label={t("marketplace.connection.payer.chooseNamed", { org: name() })}
                        onClick={() => void props.connections.choosePayer(view().id, access.orgId)}
                      >
                        {t("marketplace.connection.payer.choose")}
                      </Button>
                    </Show>
                  </ItemActions>
                </Item>
              );
            }}
          </For>
        </ItemGroup>
      </SettingsSection>

      <Show when={props.connections.agents().length > 0}>
        <SettingsSection
          title={t("marketplace.connection.agents.title")}
          description={t("marketplace.connection.agents.description")}
        >
          <ItemGroup class="settings-modal-card">
            <For each={props.connections.agents()} keyed={(agent) => agent.id}>
              {(agent) => (
                <div class="settings-modal-row marketplace-connection-agent">
                  <SwitchField
                    size="sm"
                    label={agent().name}
                    description={
                      agentOn(agent().connectionsOff)
                        ? t("marketplace.connection.agents.on", { connection: props.app.name })
                        : t("marketplace.connection.agents.off", { connection: props.app.name })
                    }
                    checked={agentOn(agent().connectionsOff)}
                    disabled={busy()}
                    onChange={(on) => void props.connections.setAgentConnection(agent().id, view().id, on)}
                  />
                </div>
              )}
            </For>
          </ItemGroup>
        </SettingsSection>
      </Show>

      <SettingsSection title={t("marketplace.connection.data.title")}>
        <ItemGroup class="settings-modal-card">
          <div class="integration-card-body marketplace-connection-copy">
            <Show when={vendor()}>
              {(name) => (
                <Text as="p" variant="body-sm" class="marketplace-connection-vendor">
                  {t("marketplace.connection.data.vendor", { vendor: name() })}
                </Text>
              )}
            </Show>
            <Text as="p" variant="body-sm">
              {vendor()
                ? t("marketplace.connection.data.flow", { vendor: vendor(), region: region() })
                : t("marketplace.connection.data.flowNoVendor")}
            </Text>
            <Text as="p" variant="body-sm">
              {t("marketplace.connection.data.key")}
            </Text>
            <Show when={view().dataPolicy.retentionDays !== null}>
              <Text as="p" variant="caption" tone="muted" class="integration-card-note">
                {view().dataPolicy.retentionDays === 0
                  ? t("marketplace.connection.data.retentionNone")
                  : t("marketplace.connection.data.retention", { count: view().dataPolicy.retentionDays ?? 0 })}
              </Text>
            </Show>
          </div>
        </ItemGroup>
      </SettingsSection>
    </IntegrationPage>
  );
}

/** What a link to a connection shows while the Hub gave no catalog: why, and Refresh. */
export function MarketplaceConnectionsNotice(props: { connections: MarketplaceConnections }) {
  const { t } = useText();
  const text = () => {
    switch (props.connections.status()) {
      case "signed_out":
        return t("marketplace.connection.notice.signedOut");
      case "off":
        return t("marketplace.connection.notice.off");
      default:
        return t("marketplace.connection.notice.unavailable");
    }
  };
  return (
    <div class="marketplace-empty" role="status">
      <Text as="p" variant="body-sm" tone="muted">
        {text()}
      </Text>
      <Show when={props.connections.status() === "unavailable"}>
        <div class="marketplace-empty-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => props.connections.refresh()}>
            {t("common.retry")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
