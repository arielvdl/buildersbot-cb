import { AppLogo } from "@openbot/brand";
import { Button, ScanFace, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";
import type { AppLockResult } from "./web-app-lock";

/**
 * The cover of the installed app while it is locked. It sits above the workspace, so the conversation
 * underneath keeps its scroll, its connection and its running turns; the passkey only uncovers it.
 */
export function WebAppLock(props: { onUnlock: () => Promise<AppLockResult>; onDisable: () => void }) {
  const { t } = useText();
  const [busy, setBusy] = createSignal(false);
  const [lost, setLost] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  async function unlock() {
    if (busy()) return;
    setBusy(true);
    setFailed(false);
    const result = await props.onUnlock();
    setBusy(false);
    if (result === "lost") setLost(true);
    else if (result === "cancelled") setFailed(true);
  }

  return (
    <div class="web-app-lock" role="dialog" aria-modal="true" aria-labelledby="web-app-lock-title">
      <div class="web-app-lock-card">
        <AppLogo variant="production" class="web-app-lock-logo" />
        <h2 id="web-app-lock-title" class="web-app-lock-title">
          {t("webClient.lock.title")}
        </h2>
        <Show
          when={!lost()}
          fallback={
            <>
              <Text tone="muted" class="web-app-lock-text">
                {t("webClient.lock.lost")}
              </Text>
              <Button variant="secondary" onClick={props.onDisable}>
                {t("webClient.lock.disable")}
              </Button>
            </>
          }
        >
          <Text tone="muted" class="web-app-lock-text">
            {t("webClient.lock.description")}
          </Text>
          <Button class="web-app-lock-button" loading={busy()} onClick={unlock} autofocus>
            <ScanFace aria-hidden="true" />
            {t("webClient.lock.unlock")}
          </Button>
          <Show when={failed()}>
            <Text tone="muted" class="web-app-lock-text">
              {t("webClient.lock.failed")}
            </Text>
          </Show>
        </Show>
      </div>
    </div>
  );
}
