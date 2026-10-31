import {
  type BuildersBotDesktopApi,
  EGRESS_DEFAULT_BYPASS,
  type EgressProxyDefaultView,
  type EgressProxyErrorReason,
  type EgressProxyLineError,
  type EgressProxyUpdate,
  type EgressProxyView,
  normalizeEgressBypassRule,
  normalizeEgressHost,
  parseEgressProxyLine,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Spinner,
  SwitchField,
  Text,
  Textarea,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, Show, untrack } from "solid-js";
import type { ServerSettingsSectionHost } from "./server-settings-section";

/** The egress proxy calls of one server's host. The desktop reaches them through main. */
export type EgressProxyCalls = Pick<
  BuildersBotDesktopApi["hostAdmin"],
  "getEgressProxy" | "setEgressProxy" | "testEgressProxy"
>;
/** The app default for new servers. Only the desktop app has one. */
export type EgressDefaultCalls = Pick<BuildersBotDesktopApi["hostAdmin"], "getEgressDefault" | "setEgressDefault">;

export interface ServerEgressOptions {
  /** The calls of a client with no `window.openbot`, such as the web client. */
  calls?: EgressProxyCalls;
  /** Present on the desktop app: the default that the servers it makes later take. */
  defaults?: EgressDefaultCalls;
}

const LINE_ERROR_TEXT = {
  format: "server.egress.pasteErrorFormat",
  scheme: "server.egress.pasteErrorScheme",
  host: "server.egress.pasteErrorHost",
  port: "server.egress.pasteErrorPort",
  username: "server.egress.pasteErrorUsername",
  password: "server.egress.pasteErrorPassword",
} as const satisfies Record<EgressProxyLineError, AppTextKey>;

const REASON_TEXT = {
  unreachable: "server.egress.reasonUnreachable",
  auth: "server.egress.reasonAuth",
  country: "server.egress.reasonCountry",
  secret: "server.egress.reasonSecret",
  incomplete: "server.egress.reasonIncomplete",
  check: "server.egress.reasonCheck",
} as const satisfies Record<EgressProxyErrorReason, AppTextKey>;

interface EgressForm {
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  /** Empty keeps the saved password. */
  password: string;
  bypass: string;
  expectedCountry: string;
  blockOtherCountry: boolean;
  useAsDefault: boolean;
}

type FormError =
  | "server.egress.errorHost"
  | "server.egress.errorPort"
  | "server.egress.errorBypass"
  | "server.egress.errorCountry"
  | "server.egress.errorDefaultPassword";

function formOf(view: EgressProxyView): EgressForm {
  return {
    enabled: view.enabled,
    host: view.host,
    port: view.port === null ? "" : String(view.port),
    username: view.username,
    password: "",
    bypass: view.bypass.join("\n"),
    expectedCountry: view.expectedCountry,
    blockOtherCountry: view.blockOtherCountry,
    useAsDefault: false,
  };
}

/** The update that the form names, or the key of its first error. The host checks it again. */
function updateOf(form: EgressForm): EgressProxyUpdate | FormError {
  // An IPv6 address can come with brackets; the stored form has none.
  const host = form.host.trim() ? normalizeEgressHost(form.host) : "";
  if (host === null) return "server.egress.errorHost";
  const port = form.port.trim() === "" ? null : Number(form.port.trim());
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) return "server.egress.errorPort";
  const rules = form.bypass
    .split(/[\n,]/u)
    .map((rule) => rule.trim())
    .filter(Boolean);
  const bypass: string[] = [];
  for (const rule of rules) {
    const normalized = normalizeEgressBypassRule(rule);
    if (!normalized) return "server.egress.errorBypass";
    if (!bypass.includes(normalized)) bypass.push(normalized);
  }
  const expectedCountry = form.expectedCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(expectedCountry)) return "server.egress.errorCountry";
  return {
    enabled: form.enabled,
    host,
    port,
    username: form.username.trim(),
    bypass,
    expectedCountry,
    blockOtherCountry: form.blockOtherCountry,
    ...(form.password ? { password: form.password } : {}),
  };
}

/**
 * Server Settings > Network egress: the HTTP proxy that every agent, tool and browser of the server
 * uses for internet traffic. Owner or admin only; the host checks the role again. The password is
 * write-only: the view says only that one is saved. See docs/architecture/egress-proxy.md.
 */
export function ServerEgressPanel(
  props: ServerEgressOptions & { serverId: string } & Pick<ServerSettingsSectionHost, "busy" | "run">,
) {
  const { t, errorMessage, format } = useText();
  const calls = (): EgressProxyCalls => props.calls ?? window.openbot.hostAdmin;
  const [view, setView] = createSignal<EgressProxyView | null>(null);
  const [defaultView, setDefaultView] = createSignal<EgressProxyDefaultView | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [pasteError, setPasteError] = createSignal<EgressProxyLineError | null>(null);
  const [formError, setFormError] = createSignal<FormError | null>(null);
  const [form, setForm] = createStore<EgressForm>({
    enabled: false,
    host: "",
    port: "",
    username: "",
    password: "",
    bypass: EGRESS_DEFAULT_BYPASS.join("\n"),
    expectedCountry: "BR",
    blockOtherCountry: true,
    useAsDefault: false,
  });

  const show = (next: EgressProxyView) => {
    setView(next);
    const values = formOf(next);
    setForm((current) => {
      Object.assign(current, values);
    });
  };
  const read = () => {
    setLoadError(null);
    calls()
      .getEgressProxy(props.serverId)
      .then(show, (error: unknown) => setLoadError(errorMessage(error, t("server.egress.loadFailed"))));
    props.defaults?.getEgressDefault().then(setDefaultView, () => setDefaultView(null));
  };
  // The panel mounts when the section opens, so each visit reads the setting again.
  untrack(read);

  const edit = <Key extends keyof EgressForm>(key: Key, value: EgressForm[Key]) =>
    setForm((current) => {
      current[key] = value;
    });

  function paste(text: string): void {
    if (!text.trim()) {
      setPasteError(null);
      return;
    }
    const result = parseEgressProxyLine(text);
    if (!result.ok) {
      setPasteError(result.error);
      return;
    }
    setPasteError(null);
    setForm((current) => {
      current.host = result.value.host;
      current.port = String(result.value.port);
      current.username = result.value.username;
      current.password = result.value.password;
    });
  }

  function save(): void {
    const update = updateOf(form);
    if (typeof update === "string") {
      setFormError(update);
      return;
    }
    // The host never gives the password back, so a default with a user needs it typed here.
    if (form.useAsDefault && update.username && update.password === undefined) {
      setFormError("server.egress.errorDefaultPassword");
      return;
    }
    setFormError(null);
    const serverId = props.serverId;
    const defaults = props.defaults;
    void props.run("egress-save", async () => {
      show(await calls().setEgressProxy(update, serverId));
      if (form.useAsDefault && defaults) setDefaultView(await defaults.setEgressDefault({ ...update, enabled: true }));
    });
  }

  const test = () =>
    void props.run("egress-test", async () => {
      show(await calls().testEgressProxy(props.serverId));
    });
  const removeDefault = () =>
    void props.run("egress-default-remove", async () => {
      setDefaultView((await props.defaults?.setEgressDefault(null)) ?? null);
    });

  const stateBadge = () => {
    const state = view()?.state;
    if (state === "active") return { variant: "success-light" as const, text: t("server.egress.stateActive") };
    if (state === "error") return { variant: "destructive-light" as const, text: t("server.egress.stateError") };
    return { variant: "secondary" as const, text: t("server.egress.stateOff") };
  };
  const checkedAt = (value: string) => format.date(new Date(value), { dateStyle: "short", timeStyle: "short" });

  return (
    <SettingsSection title={t("server.egress.title")} description={t("server.egress.description")}>
      <Show when={loadError()}>
        {(message) => (
          <Alert tone="danger" role="alert">
            <AlertContent>
              <AlertDescription>{message()}</AlertDescription>
            </AlertContent>
            <AlertActions>
              <Button type="button" size="sm" variant="outline" onClick={read}>
                {t("common.retry")}
              </Button>
            </AlertActions>
          </Alert>
        )}
      </Show>
      <Show when={!view() && !loadError()}>
        <Spinner label={t("server.egress.loading")} />
      </Show>
      <Show when={view()}>
        {(current) => (
          <>
            <Show when={current().state === "error" && current().reason}>
              {(reason) => (
                <Alert tone="danger" role="alert">
                  <AlertContent>
                    <AlertTitle>{t("server.egress.errorTitle")}</AlertTitle>
                    <AlertDescription>{t(REASON_TEXT[reason()])}</AlertDescription>
                  </AlertContent>
                  <AlertActions>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={props.busy() === "egress-test"}
                      disabled={Boolean(props.busy())}
                      onClick={test}
                    >
                      {t("common.retry")}
                    </Button>
                  </AlertActions>
                </Alert>
              )}
            </Show>
            <ItemGroup class="settings-modal-card">
              <SwitchField
                data-settings-row="server.egress.enabled"
                checked={form.enabled}
                onChange={(checked) => edit("enabled", checked)}
                label={t("server.egress.enabled")}
                description={t("server.egress.enabledDescription")}
              />
              <Item>
                <ItemContent>
                  <Field
                    label={t("server.egress.paste")}
                    description={t("server.egress.pasteDescription")}
                    error={pasteError() ? t(LINE_ERROR_TEXT[pasteError() ?? "format"]) : undefined}
                  >
                    <Input
                      size="md"
                      autocomplete="off"
                      spellcheck={false}
                      placeholder={t("server.egress.pastePlaceholder")}
                      onValueChange={paste}
                    />
                  </Field>
                  <Field label={t("server.egress.host")}>
                    <Input
                      size="md"
                      autocomplete="off"
                      spellcheck={false}
                      value={form.host}
                      onValueChange={(value) => edit("host", value)}
                    />
                  </Field>
                  <Field label={t("server.egress.port")}>
                    <Input
                      size="md"
                      inputmode="numeric"
                      autocomplete="off"
                      value={form.port}
                      onValueChange={(value) => edit("port", value)}
                    />
                  </Field>
                  <Field label={t("server.egress.username")}>
                    <Input
                      size="md"
                      autocomplete="off"
                      spellcheck={false}
                      value={form.username}
                      onValueChange={(value) => edit("username", value)}
                    />
                  </Field>
                  <Field
                    label={t("server.egress.password")}
                    description={current().passwordSaved ? t("server.egress.passwordSaved") : undefined}
                  >
                    <Input
                      size="md"
                      type="password"
                      autocomplete="new-password"
                      placeholder={current().passwordSaved ? t("server.egress.passwordSavedPlaceholder") : undefined}
                      value={form.password}
                      onInput={(event) => edit("password", event.currentTarget.value)}
                    />
                  </Field>
                </ItemContent>
              </Item>
              <Item>
                <ItemContent>
                  <Field label={t("server.egress.bypass")} description={t("server.egress.bypassDescription")}>
                    <Textarea
                      rows={6}
                      spellcheck={false}
                      value={form.bypass}
                      onValueChange={(value) => edit("bypass", value)}
                    />
                  </Field>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => edit("bypass", EGRESS_DEFAULT_BYPASS.join("\n"))}
                  >
                    {t("server.egress.bypassRestore")}
                  </Button>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <Field label={t("server.egress.country")} description={t("server.egress.countryDescription")}>
                    <Input
                      size="md"
                      maxlength={2}
                      autocomplete="off"
                      value={form.expectedCountry}
                      onValueChange={(value) => edit("expectedCountry", value)}
                    />
                  </Field>
                </ItemContent>
              </Item>
              <SwitchField
                checked={form.blockOtherCountry}
                onChange={(checked) => edit("blockOtherCountry", checked)}
                label={t("server.egress.blockOtherCountry")}
                description={t("server.egress.blockOtherCountryDescription")}
              />
              <Show when={props.defaults}>
                <SwitchField
                  checked={form.useAsDefault}
                  onChange={(checked) => edit("useAsDefault", checked)}
                  label={t("server.egress.useAsDefault")}
                  description={t("server.egress.useAsDefaultDescription")}
                />
              </Show>
            </ItemGroup>
            <Show when={formError()}>
              {(key) => (
                <Text variant="caption" tone="danger" role="alert">
                  {t(key())}
                </Text>
              )}
            </Show>
            <ItemGroup class="settings-modal-card">
              <Item>
                <ItemContent>
                  <ItemTitle>
                    {t("server.egress.state")} <Badge variant={stateBadge().variant}>{stateBadge().text}</Badge>
                  </ItemTitle>
                  <Show
                    when={current().lastCheck}
                    fallback={<ItemDescription>{t("server.egress.notChecked")}</ItemDescription>}
                  >
                    {(check) => (
                      <>
                        <ItemDescription>
                          {t("server.egress.lastCheck", {
                            ip: check().ip,
                            city: check().city ?? t("server.egress.unknownPlace"),
                            country: check().country ?? t("server.egress.unknownPlace"),
                            time: checkedAt(check().checkedAt),
                          })}
                        </ItemDescription>
                        <Show when={!check().countryMatches}>
                          <Text variant="caption" tone="warning" role="alert">
                            {t("server.egress.countryMismatch", {
                              country: check().country ?? t("server.egress.unknownPlace"),
                              expected: current().expectedCountry,
                            })}
                          </Text>
                        </Show>
                      </>
                    )}
                  </Show>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={props.busy() === "egress-test"}
                    disabled={Boolean(props.busy()) || !current().enabled}
                    onClick={test}
                  >
                    {t("server.egress.test")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    loading={props.busy() === "egress-save"}
                    disabled={Boolean(props.busy())}
                    onClick={save}
                  >
                    {t("common.save")}
                  </Button>
                </ItemActions>
              </Item>
              <Show when={defaultView()}>
                {(saved) => (
                  <Item>
                    <ItemContent>
                      <ItemTitle>{t("server.egress.defaultTitle")}</ItemTitle>
                      <ItemDescription>
                        {t("server.egress.defaultSummary", {
                          host: saved().host,
                          port: saved().port === null ? "" : String(saved().port),
                          user: saved().username || t("server.egress.noUser"),
                        })}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={props.busy() === "egress-default-remove"}
                        disabled={Boolean(props.busy())}
                        onClick={removeDefault}
                      >
                        {t("server.egress.defaultRemove")}
                      </Button>
                    </ItemActions>
                  </Item>
                )}
              </Show>
            </ItemGroup>
          </>
        )}
      </Show>
    </SettingsSection>
  );
}
