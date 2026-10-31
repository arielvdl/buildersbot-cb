import {
  cleanWhatsAppAccountName,
  DEFAULT_WHATSAPP_REGION,
  normalizeWhatsAppPhone,
  WHATSAPP_COUNTRIES,
  type WhatsAppAccount,
  type WhatsAppLinkMethod,
  whatsAppAccountSlug,
} from "@openbot/contracts/ipc";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  buttonVariants,
  Check,
  ConfirmDialog,
  DropdownMenu,
  Ellipsis,
  Field,
  Info,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Link,
  Link2Off,
  Lock,
  LockOpen,
  MessageCircle,
  NativeSelect,
  Pause,
  Play,
  Plus,
  QrCode,
  RadioGroup,
  RefreshCw,
  SettingsSection,
  Spinner,
  Text,
  Trash2,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Match, onSettled, Show, Switch, untrack } from "solid-js";
import { StatusPill, WizardDialog } from "../settings/IntegrationLayout";
import {
  canLink,
  countdown,
  WHATSAPP_ERROR_TEXT,
  WHATSAPP_NOTICE_TEXT,
  WHATSAPP_STATE_LABEL,
  WHATSAPP_STATE_PILL,
  type WhatsAppAccountsModel,
} from "./whatsapp-accounts-model";

/** What the confirmation is about. `next` is the account that becomes the default after a remove. */
interface PendingConfirm {
  action: "unlink" | "remove" | "disable";
  account: WhatsAppAccount;
  next: WhatsAppAccount | undefined;
}

/** The account that the link dialog is for, and the number that the add dialog took, if any. */
interface LinkTarget {
  account: Pick<WhatsAppAccount, "id" | "name">;
  phone: string | null;
}

/**
 * The accounts of the wazap server on the plugin page. On a joined server the accounts are on the
 * host's computer, so the panel says where to manage them.
 */
export function WhatsAppAccountsPanel(props: {
  model: WhatsAppAccountsModel | undefined;
  hostName: string | undefined;
}) {
  const { t } = useText();
  return (
    <Show
      when={props.hostName === undefined ? props.model : undefined}
      fallback={
        <Show when={props.hostName}>
          {(host) => (
            <SettingsSection title={t("plugin.whatsapp.title")}>
              <Alert tone="neutral">
                <AlertIcon>
                  <Info />
                </AlertIcon>
                <AlertContent>
                  <AlertDescription>{t("plugin.whatsapp.remote", { host: host() })}</AlertDescription>
                </AlertContent>
              </Alert>
            </SettingsSection>
          )}
        </Show>
      }
    >
      {(model) => <AccountsSection model={model()} />}
    </Show>
  );
}

function AccountsSection(props: { model: WhatsAppAccountsModel }) {
  const { t } = useText();
  /** The title, the text and the button of a confirmation. */
  const confirmText = (pending: PendingConfirm) => {
    const name = pending.account.name;
    switch (pending.action) {
      case "unlink":
        return {
          title: t("plugin.whatsapp.unlinkTitle", { name }),
          description: t("plugin.whatsapp.unlinkDescription"),
          label: t("plugin.whatsapp.action.unlink"),
        };
      case "disable":
        return {
          title: t("plugin.whatsapp.disableTitle", { name }),
          description: t("plugin.whatsapp.disableDescription", { name }),
          label: t("plugin.whatsapp.action.disable"),
        };
      case "remove":
        return {
          title: t("plugin.whatsapp.removeTitle", { name }),
          description: [
            t("plugin.whatsapp.removeDescription", { name }),
            pending.next ? t("plugin.whatsapp.removeDefaultNext", { next: pending.next.name }) : "",
          ]
            .filter(Boolean)
            .join(" "),
          label: t("plugin.whatsapp.action.remove"),
        };
    }
  };
  const model = () => props.model;
  const [adding, setAdding] = createSignal(false);
  const [linking, setLinking] = createSignal<LinkTarget | null>(null);
  const [confirm, setConfirm] = createSignal<PendingConfirm | null>(null);
  const ready = () => {
    const snapshot = model().snapshot();
    return snapshot?.status === "ready" ? snapshot : null;
  };
  const unavailable = () => {
    const snapshot = model().snapshot();
    return snapshot?.status === "unavailable" ? snapshot.error : null;
  };
  // `status --json` starts `npx`, so the list is read when the page opens, not with the Marketplace.
  onSettled(() => {
    if (!model().snapshot()) void model().refresh();
  });

  return (
    <SettingsSection
      title={t("plugin.whatsapp.title")}
      description={t("plugin.whatsapp.description")}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={model().busy()}
            onClick={() => void model().refresh()}
          >
            <RefreshCw aria-hidden="true" />
            {t("plugin.whatsapp.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready() || model().busy()}
            onClick={() => {
              model().clearMessages();
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            {t("plugin.whatsapp.add")}
          </Button>
        </>
      }
    >
      <Switch>
        <Match when={!model().snapshot()}>
          <ItemGroup class="settings-modal-card">
            <Item class="settings-modal-row">
              <Spinner size="sm" />
              <ItemContent>
                <ItemDescription>{t("plugin.whatsapp.loading")}</ItemDescription>
              </ItemContent>
            </Item>
          </ItemGroup>
        </Match>
        <Match when={unavailable()}>
          {(error) => (
            <Alert tone="warning" role="alert">
              <AlertIcon>
                <TriangleAlert />
              </AlertIcon>
              <AlertContent>
                <AlertTitle>{t("plugin.whatsapp.unavailable")}</AlertTitle>
                <AlertDescription>{t(WHATSAPP_ERROR_TEXT[error()])}</AlertDescription>
              </AlertContent>
              <AlertActions>
                <Button type="button" variant="outline" size="sm" onClick={() => void model().refresh()}>
                  {t("common.retry")}
                </Button>
              </AlertActions>
            </Alert>
          )}
        </Match>
        <Match when={ready()}>
          {(snapshot) => (
            <>
              <Show when={snapshot().globalReadOnly}>
                <Alert tone="neutral">
                  <AlertIcon>
                    <Lock />
                  </AlertIcon>
                  <AlertContent>
                    <AlertDescription>{t("plugin.whatsapp.globalReadOnly")}</AlertDescription>
                  </AlertContent>
                </Alert>
              </Show>
              <ItemGroup class="settings-modal-card">
                <For each={snapshot().accounts}>
                  {(account) => (
                    <AccountRow
                      model={model()}
                      account={account}
                      globalReadOnly={snapshot().globalReadOnly}
                      onLink={() => {
                        model().clearMessages();
                        setLinking({ account, phone: null });
                      }}
                      onConfirm={(action) =>
                        setConfirm({
                          action,
                          account,
                          // wazap makes the first account left the default.
                          next: account.isDefault
                            ? snapshot().accounts.find((other) => other.id !== account.id)
                            : undefined,
                        })
                      }
                    />
                  )}
                </For>
              </ItemGroup>
            </>
          )}
        </Match>
      </Switch>
      <Show when={model().error()}>
        {(error) => (
          <Alert tone="warning" role="alert">
            <AlertIcon>
              <TriangleAlert />
            </AlertIcon>
            <AlertContent>
              <AlertDescription>{t(WHATSAPP_ERROR_TEXT[error()])}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </Show>
      <Show when={model().notice()}>
        {(notice) => (
          <Text as="p" variant="caption" tone="muted" role="status">
            {t(WHATSAPP_NOTICE_TEXT[notice()])}
          </Text>
        )}
      </Show>
      <AddAccountDialog
        open={adding()}
        model={model()}
        taken={ready()?.accounts.map((account) => account.id) ?? []}
        onClose={() => setAdding(false)}
        onAdded={(target) => {
          setAdding(false);
          setLinking(target);
        }}
      />
      <Show when={linking()} keyed>
        {(target) => <LinkDialog model={model()} target={target} onClose={() => setLinking(null)} />}
      </Show>
      <Show when={confirm()} keyed>
        {(pending) => (
          <ConfirmDialog
            open={true}
            initialFocus="cancel"
            tone="destructive"
            title={confirmText(pending).title}
            description={confirmText(pending).description}
            confirmLabel={confirmText(pending).label}
            onCancel={() => setConfirm(null)}
            onConfirm={async () => {
              await model().act({ action: pending.action, id: pending.account.id, confirm: pending.account.id });
              setConfirm(null);
            }}
          />
        )}
      </Show>
    </SettingsSection>
  );
}

function AccountRow(props: {
  model: WhatsAppAccountsModel;
  account: WhatsAppAccount;
  globalReadOnly: boolean;
  onLink: () => void;
  onConfirm: (action: PendingConfirm["action"]) => void;
}) {
  const { t } = useText();
  const account = () => props.account;
  const details = () =>
    [
      account().number ??
        (account().formerNumber
          ? t("plugin.whatsapp.formerNumber", { number: account().formerNumber ?? "" })
          : account().unlinkedHistory
            ? t("plugin.whatsapp.unlinkedHistory")
            : t("plugin.whatsapp.state.notLinked")),
      account().messages === null ? "" : t("plugin.whatsapp.messages", { count: account().messages ?? 0 }),
      t("plugin.whatsapp.accountId", { id: account().id }),
    ]
      .filter(Boolean)
      .join(" · ");
  const act = (action: "enable" | "default" | "read-only" | "writable") =>
    void props.model.act({ action, id: account().id });
  return (
    <Item class="settings-modal-row whatsapp-account-row">
      <ItemContent>
        <ItemTitle>
          {account().name}
          <Show when={account().isDefault}>
            <Badge variant="secondary">{t("plugin.whatsapp.default")}</Badge>
          </Show>
          <Show
            when={props.globalReadOnly}
            fallback={
              <Show when={account().readOnly}>
                <Badge variant="outline">{t("plugin.whatsapp.readOnly")}</Badge>
              </Show>
            }
          >
            <Badge variant="outline">{t("plugin.whatsapp.readOnlyGlobal")}</Badge>
          </Show>
        </ItemTitle>
        <ItemDescription>{details()}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <StatusPill status={WHATSAPP_STATE_PILL[account().state]} label={t(WHATSAPP_STATE_LABEL[account().state])} />
        <Show when={canLink(account())}>
          <Button type="button" variant="outline" size="sm" disabled={props.model.busy()} onClick={props.onLink}>
            <Link aria-hidden="true" />
            {t("plugin.whatsapp.action.link")}
          </Button>
        </Show>
        <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
          <DropdownMenu.Trigger
            class={`${buttonVariants({ variant: "ghost", size: "icon-sm" })} ui-icon-button`}
            aria-label={t("plugin.whatsapp.action.more", { name: account().name })}
            disabled={props.model.busy()}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <Show when={account().number !== null}>
                <DropdownMenu.Item onSelect={() => props.onConfirm("unlink")}>
                  <Link2Off aria-hidden="true" />
                  {t("plugin.whatsapp.action.unlink")}
                </DropdownMenu.Item>
              </Show>
              <Show when={!account().isDefault}>
                <DropdownMenu.Item onSelect={() => act("default")}>
                  <Check aria-hidden="true" />
                  {t("plugin.whatsapp.action.default")}
                </DropdownMenu.Item>
              </Show>
              <Show
                when={account().state === "disabled"}
                fallback={
                  <DropdownMenu.Item onSelect={() => props.onConfirm("disable")}>
                    <Pause aria-hidden="true" />
                    {t("plugin.whatsapp.action.disable")}
                  </DropdownMenu.Item>
                }
              >
                <DropdownMenu.Item onSelect={() => act("enable")}>
                  <Play aria-hidden="true" />
                  {t("plugin.whatsapp.action.enable")}
                </DropdownMenu.Item>
              </Show>
              <Show
                when={account().readOnly}
                fallback={
                  <DropdownMenu.Item onSelect={() => act("read-only")}>
                    <Lock aria-hidden="true" />
                    {t("plugin.whatsapp.action.readOnly")}
                  </DropdownMenu.Item>
                }
              >
                <DropdownMenu.Item onSelect={() => act("writable")}>
                  <LockOpen aria-hidden="true" />
                  {t("plugin.whatsapp.action.writable")}
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => props.onConfirm("remove")}>
                <Trash2 aria-hidden="true" />
                {t("plugin.whatsapp.action.remove")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </ItemActions>
    </Item>
  );
}

/** The country names in the reader's language. A runtime with no region names shows the codes. */
function countryName(locale: string, region: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(region) ?? region;
  } catch {
    return region;
  }
}

/** A country and a number. `onChange` gets the number in E.164, or null while it is not valid. */
function PhoneFields(props: { onChange: (phone: string | null) => void; invalid: boolean }) {
  const { t, locale } = useText();
  const [region, setRegion] = createSignal(DEFAULT_WHATSAPP_REGION);
  const [text, setText] = createSignal("");
  const phone = () => normalizeWhatsAppPhone(text(), region());
  const update = () => props.onChange(phone());
  return (
    <div class="whatsapp-phone-fields">
      <Field label={t("plugin.whatsapp.country")}>
        <NativeSelect
          value={region()}
          onChange={(event) => {
            setRegion(event.currentTarget.value);
            update();
          }}
        >
          <For each={WHATSAPP_COUNTRIES}>
            {(country) => (
              <option value={country.region}>{`${countryName(locale(), country.region)} (+${country.dial})`}</option>
            )}
          </For>
        </NativeSelect>
      </Field>
      <Field
        label={t("plugin.whatsapp.number")}
        description={
          phone() ? t("plugin.whatsapp.numberPreview", { number: phone() ?? "" }) : t("plugin.whatsapp.numberHint")
        }
        error={props.invalid ? t("plugin.whatsapp.invalidNumber") : undefined}
      >
        <Input
          type="tel"
          inputmode="tel"
          autocomplete="off"
          value={text()}
          onInput={(event) => {
            setText(event.currentTarget.value);
            update();
          }}
        />
      </Field>
    </div>
  );
}

function AddAccountDialog(props: {
  open: boolean;
  model: WhatsAppAccountsModel;
  taken: readonly string[];
  onClose: () => void;
  onAdded: (target: LinkTarget) => void;
}) {
  const { t } = useText();
  const [name, setName] = createSignal("");
  const [phone, setPhone] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const cleanName = () => cleanWhatsAppAccountName(name());
  const slug = () => whatsAppAccountSlug(name(), props.taken);
  const submit = async () => {
    setTried(true);
    const nickname = cleanName();
    const number = phone();
    if (nickname === null || number === null) return;
    const id = slug();
    if (await props.model.add({ id, name: nickname, phone: number })) {
      setName("");
      setTried(false);
      props.onAdded({ account: { id, name: nickname }, phone: number });
    }
  };
  return (
    <WizardDialog
      open={props.open}
      nested
      closeLabel={t("common.close")}
      dismissible={!props.model.busy()}
      onClose={props.onClose}
      logo={<MessageCircle aria-hidden="true" />}
      title={t("plugin.whatsapp.addTitle")}
      description={t("plugin.whatsapp.addDescription")}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button type="button" variant="outline" disabled={props.model.busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={props.model.busy()}>
            {t("plugin.whatsapp.addConfirm")}
          </Button>
        </>
      }
    >
      <Field
        label={t("plugin.whatsapp.nickname")}
        description={cleanName() ? t("plugin.whatsapp.accountId", { id: slug() }) : undefined}
        error={tried() && cleanName() === null ? t("plugin.whatsapp.invalidName") : undefined}
      >
        <Input
          value={name()}
          maxlength={64}
          placeholder={t("plugin.whatsapp.nicknamePlaceholder")}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <PhoneFields onChange={setPhone} invalid={tried() && phone() === null} />
      <Show when={props.model.error()}>
        {(error) => (
          <Text as="p" variant="body-sm" tone="danger" role="alert">
            {t(WHATSAPP_ERROR_TEXT[error()])}
          </Text>
        )}
      </Show>
      <Alert tone="neutral">
        <AlertIcon>
          <Info />
        </AlertIcon>
        <AlertContent>
          <AlertDescription>{t("plugin.whatsapp.consent")}</AlertDescription>
        </AlertContent>
      </Alert>
    </WizardDialog>
  );
}

/**
 * The link step: the way to link, then the code or the QR with its countdown. The pairing goes on in
 * main while the dialog shows; closing the dialog ends a pairing that waits.
 */
function LinkDialog(props: { model: WhatsAppAccountsModel; target: LinkTarget; onClose: () => void }) {
  const { t } = useText();
  const [method, setMethod] = createSignal<WhatsAppLinkMethod>("code");
  // The number that the add dialog took, read once: the dialog is made again for another account.
  const [phone, setPhone] = createSignal<string | null>(untrack(() => props.target.phone));
  const [tried, setTried] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // The countdown's clock, for as long as the dialog shows.
  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const link = () => {
    const current = props.model.link();
    return current?.id === props.target.account.id ? current.state : null;
  };
  const start = () => {
    setTried(true);
    const number = phone();
    if (method() === "code" && number === null) return;
    void props.model.startLink({ id: props.target.account.id, method: method(), phone: number });
  };
  const close = () => {
    void props.model.closeLink();
    props.onClose();
  };
  const linkedState = () => {
    const state = link();
    return state?.phase === "linked" ? state : undefined;
  };
  const linked = () => linkedState() !== undefined;
  /** A code or a QR that still works: asking for another one before it expires gives no new one. */
  const stillValid = () => {
    const state = link();
    return (state?.phase === "code" || state?.phase === "qr") && now() < state.expiresAt;
  };
  const codeState = () => {
    const state = link();
    return state?.phase === "code" ? state : undefined;
  };
  const qrState = () => {
    const state = link();
    return state?.phase === "qr" ? state : undefined;
  };
  const failedState = () => {
    const state = link();
    return state?.phase === "failed" ? state : undefined;
  };
  return (
    <WizardDialog
      open={true}
      nested
      closeLabel={t("common.close")}
      dismissible={false}
      onClose={close}
      logo={<MessageCircle aria-hidden="true" />}
      link={linked() ? "connected" : link()?.phase === "failed" ? "broken" : "connecting"}
      title={t("plugin.whatsapp.linkTitle", { name: props.target.account.name })}
      description={t("plugin.whatsapp.linkDescription")}
      onSubmit={link() === null ? start : undefined}
      footer={
        <Switch
          fallback={
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">
                {t(method() === "code" ? "plugin.whatsapp.startCode" : "plugin.whatsapp.startQr")}
              </Button>
            </>
          }
        >
          <Match when={linked()}>
            <Button type="button" onClick={close}>
              {t("common.done")}
            </Button>
          </Match>
          <Match when={link()}>
            {(state) => (
              <>
                <Button type="button" variant="outline" onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Show when={state().phase !== "starting"}>
                  <Button type="button" variant="outline" disabled={stillValid()} onClick={start}>
                    {t(method() === "code" ? "plugin.whatsapp.newCode" : "plugin.whatsapp.newQr")}
                  </Button>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      }
    >
      <Switch>
        <Match when={link() === null}>
          <RadioGroup.Root
            class="whatsapp-method-choice"
            aria-label={t("plugin.whatsapp.method.label")}
            value={method()}
            onChange={(value) => {
              if (value === "code" || value === "qr") setMethod(value);
            }}
          >
            <MethodOption
              value="code"
              title={t("plugin.whatsapp.method.code")}
              hint={t("plugin.whatsapp.method.codeHint")}
            />
            <MethodOption value="qr" title={t("plugin.whatsapp.method.qr")} hint={t("plugin.whatsapp.method.qrHint")} />
          </RadioGroup.Root>
          <Show when={method() === "code"}>
            <Show
              when={props.target.phone}
              fallback={<PhoneFields onChange={setPhone} invalid={tried() && phone() === null} />}
            >
              {(number) => (
                <Text as="p" variant="body-sm" tone="muted">
                  {t("plugin.whatsapp.numberPreview", { number: number() })}
                </Text>
              )}
            </Show>
          </Show>
        </Match>
        <Match when={link()?.phase === "starting"}>
          <div class="whatsapp-link-wait" role="status">
            <Spinner size="sm" />
            <Text as="span" variant="body-sm" tone="muted">
              {t("plugin.whatsapp.starting")}
            </Text>
          </div>
        </Match>
        <Match when={codeState()}>
          {(state) => (
            <div class="whatsapp-link-code">
              <Text as="p" variant="body-sm">
                {t("plugin.whatsapp.codeSteps")}
              </Text>
              <output class="whatsapp-pairing-code" aria-label={t("plugin.whatsapp.method.code")}>
                {state().code}
              </output>
              <Text as="p" variant="caption" tone="muted" role="timer">
                {t("plugin.whatsapp.expiresIn", { time: countdown(state().expiresAt, now()) })}
              </Text>
              <Text as="p" variant="caption" tone="muted">
                {t("plugin.whatsapp.cancelHint")}
              </Text>
            </div>
          )}
        </Match>
        <Match when={qrState()}>
          {(state) => (
            <div class="whatsapp-link-code">
              <Text as="p" variant="body-sm">
                {t("plugin.whatsapp.qrSteps")}
              </Text>
              <QrCode
                value={props.target.account.id}
                modules={state().rows}
                size={220}
                label={t("plugin.whatsapp.qrLabel", { name: props.target.account.name })}
              />
              <Text as="p" variant="caption" tone="muted" role="timer">
                {t("plugin.whatsapp.expiresIn", { time: countdown(state().expiresAt, now()) })}
              </Text>
            </div>
          )}
        </Match>
        <Match when={linkedState()}>
          {(state) => (
            <Text as="p" variant="body-sm" role="status">
              {t(state().otherNumber ? "plugin.whatsapp.linkedOtherNumber" : "plugin.whatsapp.linked", {
                name: props.target.account.name,
              })}
            </Text>
          )}
        </Match>
        <Match when={link()?.phase === "expired"}>
          <Text as="p" variant="body-sm" role="status">
            {t("plugin.whatsapp.expired")}
          </Text>
        </Match>
        <Match when={failedState()}>
          {(state) => (
            <Alert tone="warning" role="alert">
              <AlertIcon>
                <TriangleAlert />
              </AlertIcon>
              <AlertContent>
                <AlertDescription>{t(WHATSAPP_ERROR_TEXT[state().error])}</AlertDescription>
              </AlertContent>
            </Alert>
          )}
        </Match>
      </Switch>
    </WizardDialog>
  );
}

function MethodOption(props: { value: WhatsAppLinkMethod; title: string; hint: string }) {
  return (
    <RadioGroup.Item class="whatsapp-method-option" value={props.value}>
      <RadioGroup.ItemInput />
      <RadioGroup.ItemControl class="whatsapp-method-card">
        <span class="whatsapp-method-dot" aria-hidden="true" />
        <span class="whatsapp-method-text">
          <RadioGroup.ItemLabel class="whatsapp-method-name">{props.title}</RadioGroup.ItemLabel>
          <RadioGroup.ItemDescription class="whatsapp-method-hint">{props.hint}</RadioGroup.ItemDescription>
        </span>
      </RadioGroup.ItemControl>
    </RadioGroup.Item>
  );
}
