import { agentProviderName, isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import {
  type AgentModelChoice,
  type ClientAgentModelOption,
  type ClientAgentSummary,
  DEFAULT_START_RETRY_SETTINGS,
  START_RETRY_MAX_RETRIES,
  type StartRetrySettings,
  type StartRetryState,
  startRetryDelaysSeconds,
} from "@openbot/contracts/ipc";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SwitchField,
} from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";

const RETRY_CHOICES = Array.from({ length: START_RETRY_MAX_RETRIES }, (_value, index) => index + 1);
const FIRST_DELAY_CHOICES = [5, 10, 20, 30, 60] as const;
const MAX_DELAY_CHOICES = [60, 120, 300, 600, 900] as const;
/** The waits on the backup model, one per failure in a row, as the list offers them. */
const BREAKER_CHOICES = [
  [5, 15, 30, 60],
  [10, 30, 60, 120],
  [30, 60, 120, 240],
] as const;
const NONE = "none";

function choiceKey(choice: AgentModelChoice): string {
  return `${choice.provider}\u0000${choice.providerAccountId ?? ""}\u0000${choice.model}`;
}

/**
 * Settings › Agents › "Retries and backup model": what the app does when a provider does not start a
 * turn. One place for the tries again, the wait between them, a usage limit, the default backup model,
 * and the way back to the agent's own model. Each agent can set its own backup model in its settings,
 * which comes before the default; the list below names them.
 */
export function StartRetrySettingsSection(props: {
  state: StartRetryState | null;
  /** The models of this computer, for the default backup. */
  models: readonly ClientAgentModelOption[];
  /** The local agents, for the list of the ones with a backup model of their own. */
  agents: readonly Pick<ClientAgentSummary, "id" | "name" | "backupModels">[];
  selectMount?: HTMLElement | undefined;
  onChange: (settings: StartRetrySettings) => void;
}) {
  const { t, format } = useText();
  const settings = () => props.state?.settings ?? DEFAULT_START_RETRY_SETTINGS;
  const change = (patch: Partial<StartRetrySettings>) => props.onChange({ ...settings(), ...patch });
  const delays = () => startRetryDelaysSeconds(settings()).join(", ");
  const breakerKey = (minutes: readonly number[]) => minutes.join(",");
  const breakerChoices = () => {
    const keys = BREAKER_CHOICES.map((minutes) => breakerKey(minutes));
    const current = breakerKey(settings().breakerMinutes);
    return keys.includes(current) ? keys : [...keys, current];
  };
  const fallbackOptions = () =>
    props.models.flatMap((model) =>
      isKnownAgentProvider(model.provider)
        ? [{ key: choiceKey({ provider: model.provider, model: model.id }), provider: model.provider, model }]
        : [],
    );
  const fallbackKey = () => {
    const current = settings().defaultFallback;
    return current ? choiceKey(current) : NONE;
  };
  const fallbackLabel = (key: string) => {
    if (key === NONE) return t("settings.startRetry.fallback.none");
    const option = fallbackOptions().find((item) => item.key === key);
    const current = settings().defaultFallback;
    if (!option)
      return current
        ? t("settings.startRetry.fallback.value", {
            provider: agentProviderName(current.provider),
            model: current.model,
          })
        : "";
    return t("settings.startRetry.fallback.value", {
      provider: agentProviderName(option.provider),
      model: option.model.name,
    });
  };
  const overrides = () =>
    props.agents.flatMap((agent) => {
      const backup = agent.backupModels?.automatic ? agent.backupModels.order[0] : undefined;
      return backup ? [{ agent, backup }] : [];
    });
  const agentName = (agentId: string) => props.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const time = (iso: string) => format.date(Date.parse(iso), { hour: "2-digit", minute: "2-digit" });

  return (
    <SettingsSection title={t("settings.startRetry.title")} description={t("settings.startRetry.description")}>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.retries.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.retries.description", { delays: delays() })}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<number>
              class="settings-modal-select"
              options={RETRY_CHOICES}
              value={settings().retries}
              onChange={(retries) => {
                if (retries !== null && retries !== settings().retries) change({ retries });
              }}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {t("settings.startRetry.retries.value", { count: itemProps.item.rawValue })}
                </SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.startRetry.retries.title")}>
                <SelectValue<number>>
                  {(state) => t("settings.startRetry.retries.value", { count: state.selectedOption() ?? 0 })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.firstDelay.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.firstDelay.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<number>
              class="settings-modal-select"
              options={[...new Set([...FIRST_DELAY_CHOICES, settings().firstDelaySeconds])].sort((a, b) => a - b)}
              value={settings().firstDelaySeconds}
              onChange={(seconds) => {
                if (seconds === null || seconds === settings().firstDelaySeconds) return;
                change({ firstDelaySeconds: seconds, maxDelaySeconds: Math.max(seconds, settings().maxDelaySeconds) });
              }}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {t("settings.startRetry.seconds", { count: itemProps.item.rawValue })}
                </SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.startRetry.firstDelay.title")}>
                <SelectValue<number>>
                  {(state) => t("settings.startRetry.seconds", { count: state.selectedOption() ?? 0 })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.maxDelay.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.maxDelay.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<number>
              class="settings-modal-select"
              options={[...new Set([...MAX_DELAY_CHOICES, settings().maxDelaySeconds])]
                .filter((seconds) => seconds >= settings().firstDelaySeconds)
                .sort((a, b) => a - b)}
              value={settings().maxDelaySeconds}
              onChange={(seconds) => {
                if (seconds !== null && seconds !== settings().maxDelaySeconds) change({ maxDelaySeconds: seconds });
              }}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {t("settings.startRetry.seconds", { count: itemProps.item.rawValue })}
                </SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.startRetry.maxDelay.title")}>
                <SelectValue<number>>
                  {(state) => t("settings.startRetry.seconds", { count: state.selectedOption() ?? 0 })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
        <SwitchField
          checked={settings().retryAfterUsageLimit}
          onChange={(retryAfterUsageLimit) => change({ retryAfterUsageLimit })}
          label={t("settings.startRetry.usageLimit.title")}
          description={t("settings.startRetry.usageLimit.description")}
        />
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.fallback.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.fallback.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<string>
              class="settings-modal-select"
              options={[NONE, ...fallbackOptions().map((option) => option.key)]}
              value={fallbackKey()}
              onChange={(key) => {
                if (key === null || key === fallbackKey()) return;
                const option = fallbackOptions().find((item) => item.key === key);
                change({
                  defaultFallback: option ? { provider: option.provider, model: option.model.id } : null,
                });
              }}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>{fallbackLabel(itemProps.item.rawValue)}</SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.startRetry.fallback.title")}>
                <SelectValue<string>>{(state) => fallbackLabel(state.selectedOption() ?? NONE)}</SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.breaker.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.breaker.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<string>
              class="settings-modal-select"
              options={breakerChoices()}
              value={breakerKey(settings().breakerMinutes)}
              onChange={(key) => {
                if (key === null || key === breakerKey(settings().breakerMinutes)) return;
                change({ breakerMinutes: key.split(",").map(Number) });
              }}
              placement="bottom-end"
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  {t("settings.startRetry.breaker.value", { minutes: itemProps.item.rawValue.replaceAll(",", ", ") })}
                </SelectItem>
              )}
            >
              <SelectTrigger size="sm" aria-label={t("settings.startRetry.breaker.title")}>
                <SelectValue<string>>
                  {(state) =>
                    t("settings.startRetry.breaker.value", {
                      minutes: (state.selectedOption() ?? "").replaceAll(",", ", "),
                    })
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent mount={props.selectMount} />
            </Select>
          </ItemActions>
        </Item>
      </ItemGroup>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row" data-settings-row-skip="list of the agents with a backup of their own">
          <ItemContent>
            <ItemTitle>{t("settings.startRetry.agents.title")}</ItemTitle>
            <ItemDescription>{t("settings.startRetry.agents.description")}</ItemDescription>
            <Show
              when={overrides().length > 0}
              fallback={<ItemDescription>{t("settings.startRetry.agents.none")}</ItemDescription>}
            >
              <For each={overrides()}>
                {(entry) => (
                  <ItemDescription>
                    {t("settings.startRetry.agents.value", {
                      name: entry.agent.name,
                      provider: agentProviderName(entry.backup.provider),
                      model: entry.backup.model,
                    })}
                  </ItemDescription>
                )}
              </For>
            </Show>
          </ItemContent>
        </Item>
        <Show when={props.state?.breakers.length}>
          <Item class="settings-modal-row" data-settings-row-skip="agents that run on a backup model now">
            <ItemContent>
              <ItemTitle>{t("settings.startRetry.onBackup.title")}</ItemTitle>
              <For each={props.state?.breakers ?? []}>
                {(breaker) => (
                  <ItemDescription>
                    {breaker.probing
                      ? t("settings.startRetry.onBackup.probing", {
                          name: agentName(breaker.agentId),
                          model: breaker.model,
                        })
                      : t("settings.startRetry.onBackup.value", {
                          name: agentName(breaker.agentId),
                          model: breaker.model,
                          time: time(breaker.until),
                        })}
                  </ItemDescription>
                )}
              </For>
            </ItemContent>
          </Item>
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}
