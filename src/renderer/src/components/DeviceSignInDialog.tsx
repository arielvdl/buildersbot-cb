import { Button, CopyButton, Dialog, IconButton, QrCode, Spinner, Text, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Show } from "solid-js";
import type { DeviceSignInView } from "../features/account/account-context";

/**
 * The Cultura Builder device sign-in, while it waits.
 *
 * The Hub issues a code and a page; the user confirms on the Hub, on whatever device already has a
 * session there, and the app polls until it is authorised. The dialog is the whole of that wait:
 * the primary button is the way to the Hub (with the code already in the address), the code is
 * beside it to copy, and the countdown says how long the code lives. A 429 pauses the polls and
 * offers a new try, an expired code offers a new one, and a refusal goes back to the sign-in screen.
 */

/** `m:ss`, the same shape the provider code dialog counts down with. */
function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function DeviceSignInDialog(props: {
  view: DeviceSignInView;
  /** Opens the Hub page, with the code in it, in the default browser. */
  onOpenHub: (url: string) => void;
  /** Resumes the same flow after the pause a 429 asked for. */
  onRetry: () => void;
  /** Asks for a new code, after an expired or refused one. */
  onRestart: () => void;
  onCancel: () => void;
}) {
  const { t } = useText();
  const [now, setNow] = createSignal(Date.now());
  const waiting = () => (props.view.phase === "waiting" ? props.view : null);
  const paused = () => {
    const until = waiting()?.pausedUntil;
    return until === undefined ? 0 : Math.max(0, until - now());
  };
  const pauseSeconds = () => Math.ceil(paused() / 1_000);
  const remaining = () => {
    const expiresAt = waiting()?.expiresAt;
    return expiresAt === undefined ? 0 : Math.max(0, expiresAt - now());
  };

  // The clock runs only while something counts down on screen.
  createEffect(waiting, (code) => {
    if (!code) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  });

  const hubUrl = () => {
    const code = waiting();
    return code ? (code.verificationUrlComplete ?? code.verificationUrl) : "";
  };

  const title = () => {
    switch (props.view.phase) {
      case "expired":
        return t("account.device.expired");
      case "denied":
        return t("account.device.denied");
      default:
        return t("account.device.title");
    }
  };

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="provider-code-login-backdrop">
          <Dialog.Content class="provider-code-login-dialog" as="section">
            <header class="provider-code-login-header">
              <Dialog.Title class="provider-code-login-title">{title()}</Dialog.Title>
              <Dialog.Description class="provider-code-login-description">
                {t("account.device.description")}
              </Dialog.Description>
            </header>

            <div class="provider-code-login-body">
              <Show when={props.view.phase === "starting"}>
                <div class="provider-code-login-pending" role="status">
                  <Spinner size="sm" />
                  <Text as="span" tone="muted">
                    {t("account.device.starting")}
                  </Text>
                </div>
              </Show>

              <Show when={waiting()}>
                {(code) => (
                  <div class="provider-code-login-code">
                    <div class="provider-code-login-pending" role="status">
                      <Spinner size="sm" />
                      <Text as="span" tone="muted">
                        {t("account.device.waiting")}
                      </Text>
                    </div>

                    <QrCode
                      value={hubUrl()}
                      label={t("provider.codeLogin.qrLabel", { name: "Cultura Builder" })}
                      size={160}
                    />

                    <Button
                      variant="default"
                      type="button"
                      class="account-login-primary"
                      onClick={() => props.onOpenHub(hubUrl())}
                    >
                      {t("account.device.openHub")}
                    </Button>

                    <div class="provider-code-login-value">
                      <output
                        class="provider-code-login-digits"
                        aria-label={t("provider.codeLogin.codeLabel", { code: code().userCode })}
                      >
                        {code().userCode}
                      </output>
                      <CopyButton
                        class="provider-code-login-copy"
                        value={code().userCode}
                        label={t("account.device.copyCode")}
                        copiedLabel={t("common.copied")}
                        variant="outline"
                      />
                    </div>

                    {/* Outside the region that announces the code: a countdown every second would
                      bury the thing it counts down. */}
                    <Text class="provider-code-login-expiry" as="p" variant="caption" tone="muted" aria-live="off">
                      <Show when={remaining() > 0} fallback={t("provider.codeLogin.expired")}>
                        {t("account.device.expiresIn", { time: formatCountdown(remaining()) })}
                      </Show>
                    </Text>

                    <Show when={paused() > 0 || code().pausedUntil !== undefined}>
                      <div class="provider-code-login-pending" role="status">
                        <Show when={paused() > 0}>
                          <Text as="span" tone="muted">
                            {t("account.device.rateLimited", { seconds: pauseSeconds() })}
                          </Text>
                        </Show>
                        <Button
                          variant="default"
                          type="button"
                          class="account-login-primary"
                          disabled={paused() > 0}
                          onClick={props.onRetry}
                        >
                          {t("account.device.retry")}
                        </Button>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={props.view.phase === "expired"}>
                <div class="provider-code-login-pending">
                  <Text as="p" tone="muted">
                    {t("account.device.expiredDescription")}
                  </Text>
                  <Button variant="default" type="button" class="account-login-primary" onClick={props.onRestart}>
                    {t("account.device.generateNew")}
                  </Button>
                </div>
              </Show>

              <Show when={props.view.phase === "denied"}>
                <div class="provider-code-login-pending">
                  <Text as="p" tone="muted">
                    {t("account.device.deniedDescription")}
                  </Text>
                  <Button variant="default" type="button" class="account-login-primary" onClick={props.onCancel}>
                    {t("account.device.back")}
                  </Button>
                </div>
              </Show>
            </div>

            <IconButton
              class="provider-code-login-close"
              label={t("account.device.close")}
              variant="ghost"
              onClick={props.onCancel}
            >
              <X aria-hidden="true" />
            </IconButton>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
