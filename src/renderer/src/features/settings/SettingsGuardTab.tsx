import { GUARD_LEVELS, type GuardLevel, guardEffectiveLevel, isGuardAvailableLevel } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
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
import { GuardLevelChoice, GuardSirenHero, type GuardSirenStatus } from "@openbot/ui/features/guard/GuardSiren";
import { useText } from "@openbot/ui/text";
import { For, Match, Show, Switch } from "solid-js";
import { type GuardModelRow, guardModelKey, guardModelName, type SettingsGuardStore } from "./settings-guard-store";

const LEVEL_LABEL = {
  off: "guard.level.off",
  light: "guard.level.light",
  strict: "guard.level.strict",
  "very-strict": "guard.level.veryStrict",
  custom: "guard.level.custom",
} as const satisfies Record<GuardLevel, AppTextKey>;

/** The points of "When the Guard asks you" and "What leaves the computer". */
const ASK = ["guard.ask.card", "guard.ask.remember", "guard.ask.owner"] as const satisfies ReadonlyArray<AppTextKey>;
const LEAVES = [
  "guard.leaves.suspicious",
  "guard.leaves.never",
  "guard.leaves.log",
] as const satisfies ReadonlyArray<AppTextKey>;

/** What the review model can do now: the siren and the notices of the page both read this. */
type GuardJudgeStatus = "local-only" | "signed-out" | "unavailable" | "ready";

/**
 * Settings › Guard: the siren of the Guard with the level cards under it, the level of the Guard and
 * the model that reviews suspicious items. Off and Light run now; the stricter levels show as coming
 * soon. The cards and the level list set the same level. The page says what the Guard does now, when
 * the Guard uses only the local check, such as with no Cultura Builder sign-in, when it asks the
 * person, and what leaves the computer. It links to the task reviewer, which asks the same model, to
 * the load panel, and to the security review of messages, a separate check that people can take for
 * a part of the Guard. The Guard runs on this computer, so a joined server gets a note that its own
 * Guard is not changed here.
 */
export function SettingsGuardTab(props: {
  store: SettingsGuardStore;
  selectMount: HTMLElement | undefined;
  /** The name of the joined server that the window shows, or null while this computer is active. */
  joinedServer: string | null;
  onOpenTaskReviewer: () => void;
  /** Opens the load panel of the rail. Absent while the rail does not show it. */
  onOpenLoadPanel: (() => void) | undefined;
  /** Shows the switch of the security review of messages, in General. */
  onOpenMessageReview: () => void;
  /** True while a question of the Guard of this computer waits for the person. */
  asking: boolean;
}) {
  const { t } = useText();
  const guard = () => props.store.state.guard;
  /** The saved level, or null before main answers: the page then shows no level. */
  const savedLevel = () => {
    const current = guard();
    return current ? guardEffectiveLevel(current.preference.level) : null;
  };
  /** The level that the controls of the page show while it loads: the default. */
  const level = () => savedLevel() ?? "light";
  const judge = () => guard()?.preference.judge ?? null;
  const busy = () => guard() === null || props.store.state.saving;
  const levelLabel = (value: GuardLevel) =>
    isGuardAvailableLevel(value)
      ? t(LEVEL_LABEL[value])
      : t("guard.level.comingSoon", { level: t(LEVEL_LABEL[value]) });
  const rowLabel = (row: GuardModelRow | undefined) => {
    const name = guardModelName(row, t);
    return row?.recommended ? t("guard.model.recommended", { name }) : name;
  };
  const rowFor = (key: string) => props.store.rows().find((row) => row.key === key);
  const judgeStatus = (): GuardJudgeStatus => {
    const choice = judge();
    if (!choice) return "local-only";
    if (guard()?.judgeReady === false) return choice.provider === "cultura-builder" ? "signed-out" : "unavailable";
    return "ready";
  };
  /** What the Guard does now, from the saved state and the questions that wait. */
  const sirenStatus = (): GuardSirenStatus => {
    if (!guard()) return "loading";
    if (level() === "off") return "off";
    if (props.asking) return "asking";
    return judgeStatus();
  };
  const chooseLevel = (value: GuardLevel | null | undefined) => {
    if (value && isGuardAvailableLevel(value) && value !== level()) props.store.setLevel(value);
  };

  return (
    <>
      <GuardSirenHero level={savedLevel()} status={sirenStatus()}>
        {/* Only while it loads: a card keeps the focus while the level saves, for the arrow keys. */}
        <GuardLevelChoice value={savedLevel()} disabled={guard() === null} onChange={chooseLevel} />
      </GuardSirenHero>
      <Show when={props.joinedServer}>
        {(server) => (
          <Alert tone="neutral" role="status">
            <AlertIcon>
              <Info aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.thisComputerOnly.title")}</AlertTitle>
              <AlertDescription>{t("guard.joined.description", { server: server() })}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </Show>
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
                onChange={chooseLevel}
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
            <Match when={judgeStatus() === "local-only"}>
              <Alert tone="neutral" role="status">
                <AlertIcon>
                  <Info aria-hidden="true" />
                </AlertIcon>
                <AlertContent>
                  <AlertDescription>{t("guard.notice.localOnly")}</AlertDescription>
                </AlertContent>
              </Alert>
            </Match>
            <Match when={judgeStatus() === "signed-out"}>
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
            <Match when={judgeStatus() === "unavailable"}>
              <Alert tone="warning" role="status" report={false}>
                <AlertIcon>
                  <TriangleAlert aria-hidden="true" />
                </AlertIcon>
                <AlertContent>
                  <AlertTitle>{t("guard.notice.unavailable.title")}</AlertTitle>
                  <AlertDescription>{t("guard.notice.unavailable.description")}</AlertDescription>
                </AlertContent>
              </Alert>
            </Match>
            <Match when={judgeStatus() === "ready" && judge()?.provider !== "cultura-builder"}>
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
      <SettingsSection title={t("guard.ask.title")}>
        <ItemGroup class="settings-modal-card" data-settings-row="guard.ask.title">
          <For each={ASK}>
            {(line) => (
              // A line of text with no control or title: the compact row.
              <Item size="compact">
                <ItemContent>
                  <ItemDescription>{t(line)}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("guard.leaves.title")}>
        <ItemGroup class="settings-modal-card" data-settings-row="guard.leaves.title">
          <For each={LEAVES}>
            {(line) => (
              // A line of text with no control or title: the compact row.
              <Item size="compact">
                <ItemContent>
                  <ItemDescription>{t(line)}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("guard.coverage.title")} description={t("guard.coverage.description")} />
      <SettingsSection title={t("guard.related.title")}>
        <ItemGroup class="settings-modal-card">
          <Item class="settings-modal-row" data-settings-row-skip="link to the task reviewer page">
            <ItemContent>
              <ItemTitle>{t("settings.tab.taskReviewer.title")}</ItemTitle>
              <ItemDescription>{t("guard.related.taskReviewer")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("settings.related.open", { name: t("settings.tab.taskReviewer.title") })}
                onClick={() => props.onOpenTaskReviewer()}
              >
                {t("common.open")}
              </Button>
            </ItemActions>
          </Item>
          <Item class="settings-modal-row" data-settings-row-skip="link to the load panel">
            <ItemContent>
              <ItemTitle>{t("settings.loadPanel.title")}</ItemTitle>
              <ItemDescription>
                {props.onOpenLoadPanel ? t("settings.loadPanel.description") : t("settings.loadPanel.unavailable")}
              </ItemDescription>
            </ItemContent>
            <Show when={props.onOpenLoadPanel}>
              {(open) => (
                <ItemActions>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("settings.related.open", { name: t("settings.loadPanel.title") })}
                    onClick={() => open()()}
                  >
                    {t("common.open")}
                  </Button>
                </ItemActions>
              )}
            </Show>
          </Item>
          <Item class="settings-modal-row" data-settings-row-skip="link to the security review of messages">
            <ItemContent>
              <ItemTitle>{t("settings.promptGuard.title")}</ItemTitle>
              <ItemDescription>{t("guard.related.messageReview")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("settings.related.open", { name: t("settings.promptGuard.title") })}
                onClick={() => props.onOpenMessageReview()}
              >
                {t("common.open")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>
    </>
  );
}
