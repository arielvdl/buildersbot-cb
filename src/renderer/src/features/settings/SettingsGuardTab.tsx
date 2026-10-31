import {
  GUARD_LEVELS,
  type GuardLevel,
  guardEffectiveLevel,
  isGuardAvailableLevel,
  providerDisplayName,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Info,
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
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Match, Show, Switch } from "solid-js";
import { type GuardModelRow, guardModelKey, type SettingsGuardStore } from "./settings-guard-store";

const LEVEL_LABEL = {
  off: "guard.level.off",
  light: "guard.level.light",
  strict: "guard.level.strict",
  "very-strict": "guard.level.veryStrict",
  custom: "guard.level.custom",
} as const satisfies Record<GuardLevel, AppTextKey>;

/**
 * Settings › Guard: the level of the Guard and the model that reviews suspicious items. Off and
 * Light run now; the stricter levels show as coming soon. The page says when the Guard uses only
 * the local check, such as with no Cultura Builder sign-in.
 */
export function SettingsGuardTab(props: { store: SettingsGuardStore; selectMount: HTMLElement | undefined }) {
  const { t } = useText();
  const guard = () => props.store.state.guard;
  const level = () => {
    const current = guard();
    return current ? guardEffectiveLevel(current.preference.level) : "light";
  };
  const judge = () => guard()?.preference.judge ?? null;
  const busy = () => guard() === null || props.store.state.saving;
  const levelLabel = (value: GuardLevel) =>
    isGuardAvailableLevel(value)
      ? t(LEVEL_LABEL[value])
      : t("guard.level.comingSoon", { level: t(LEVEL_LABEL[value]) });
  const rowLabel = (row: GuardModelRow | undefined) => {
    if (!row?.choice) return t("guard.model.localOnly");
    const label = t("guard.model.label", { provider: providerDisplayName(row.choice.provider), model: row.name });
    return row.recommended ? t("guard.model.recommended", { name: label }) : label;
  };
  const rowFor = (key: string) => props.store.rows().find((row) => row.key === key);

  return (
    <>
      <SettingsSection title={t("guard.section.title")}>
        <ItemGroup class="settings-modal-card">
          <Item data-settings-row="guard.level.title" class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("guard.level.title")}</ItemTitle>
              <ItemDescription>{t("guard.level.description")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<GuardLevel>
                class="settings-modal-select"
                options={[...GUARD_LEVELS]}
                value={level()}
                disabled={busy()}
                optionDisabled={(option) => !isGuardAvailableLevel(option)}
                onChange={(value) => {
                  if (value && isGuardAvailableLevel(value) && value !== level()) props.store.setLevel(value);
                }}
                placement="bottom-end"
                itemComponent={(itemProps) => (
                  <SelectItem item={itemProps.item}>{levelLabel(itemProps.item.rawValue)}</SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={t("guard.level.title")}>
                  <SelectValue<GuardLevel>>{(state) => levelLabel(state.selectedOption())}</SelectValue>
                </SelectTrigger>
                <SelectContent mount={props.selectMount} />
              </Select>
            </ItemActions>
          </Item>
          <Item class="settings-modal-row">
            <ItemContent>
              <ItemDescription>
                {level() === "off" ? t("guard.level.offExplain") : t("guard.level.lightExplain")}
              </ItemDescription>
            </ItemContent>
          </Item>
          <Show when={level() !== "off"}>
            <Item data-settings-row="guard.model.title" class="settings-modal-row">
              <ItemContent>
                <ItemTitle>{t("guard.model.title")}</ItemTitle>
                <ItemDescription>{t("guard.model.description")}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Select<string>
                  class="settings-modal-select"
                  options={props.store.rows().map((row) => row.key)}
                  value={guardModelKey(judge())}
                  disabled={busy()}
                  onChange={(key) => {
                    const row = key ? rowFor(key) : undefined;
                    if (row && key !== guardModelKey(judge())) props.store.setJudge(row.choice);
                  }}
                  placement="bottom-end"
                  itemComponent={(itemProps) => (
                    <SelectItem item={itemProps.item}>{rowLabel(rowFor(itemProps.item.rawValue))}</SelectItem>
                  )}
                >
                  <SelectTrigger size="sm" aria-label={t("guard.model.title")}>
                    <SelectValue<string>>{(state) => rowLabel(rowFor(state.selectedOption()))}</SelectValue>
                  </SelectTrigger>
                  <SelectContent mount={props.selectMount} />
                </Select>
              </ItemActions>
            </Item>
          </Show>
        </ItemGroup>
        <Show when={guard() !== null && level() !== "off"}>
          <Switch>
            <Match when={judge() === null}>
              <Alert tone="neutral" role="status">
                <AlertIcon>
                  <Info aria-hidden="true" />
                </AlertIcon>
                <AlertContent>
                  <AlertDescription>{t("guard.notice.localOnly")}</AlertDescription>
                </AlertContent>
              </Alert>
            </Match>
            <Match when={judge()?.provider === "cultura-builder" && guard()?.judgeReady === false}>
              <Alert tone="warning" role="status" report={false}>
                <AlertIcon>
                  <TriangleAlert aria-hidden="true" />
                </AlertIcon>
                <AlertContent>
                  <AlertTitle>{t("guard.notice.signedOut.title")}</AlertTitle>
                  <AlertDescription>{t("guard.notice.signedOut.description")}</AlertDescription>
                </AlertContent>
              </Alert>
            </Match>
            <Match when={judge() !== null && judge()?.provider !== "cultura-builder"}>
              <Alert tone="neutral" role="status">
                <AlertIcon>
                  <Info aria-hidden="true" />
                </AlertIcon>
                <AlertContent>
                  <AlertDescription>{t("guard.model.slower")}</AlertDescription>
                </AlertContent>
              </Alert>
            </Match>
          </Switch>
        </Show>
      </SettingsSection>
      <SettingsSection title={t("guard.coverage.title")} description={t("guard.coverage.description")} />
    </>
  );
}
