import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  CircleCheck,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Text,
} from "@openbot/ui";
import { createStore, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";

/**
 * Whether a phone can reach the server of this computer:
 * - `online`: published and connected.
 * - `starting`: being published or connected now.
 * - `disconnected`: published, but not connected now, such as after sleep while the network comes back.
 *   Builders Bot publishes it again by itself.
 * - `offline`: not published.
 *
 * `message` is the source text of the last failure of the host, or null.
 */
export interface MobileConnectReach {
  state: "online" | "starting" | "disconnected" | "offline";
  message: string | null;
}

interface MobileConnectReachNoticeProps {
  reach: MobileConnectReach;
  /** Publishes the server of this computer. Without it, the notice only tells where the switch is. */
  onPublish?: (() => Promise<void>) | undefined;
}

/**
 * Tells whether a phone can reach this computer, and publishes its server when the user selects it.
 *
 * The web app on a phone lists only published servers. A phone that signs in before this computer is
 * published shows no server, so this notice is in the Mobile Connect tab and in the sign-in step of
 * "Add phone". It publishes only on a click: a published server is on the account service, and the
 * members of the server can connect to it. The settings search finds it as "Publish this server".
 */
export function MobileConnectReachNotice(props: MobileConnectReachNoticeProps) {
  const { t, errorMessage, sourceText } = useText();
  const [state, setState] = createStore<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  /** The cause that the host gave for its last failure, in the language of the app. */
  const hostMessage = () => (props.reach.message ? sourceText(props.reach.message) : null);
  const publish = async () => {
    const run = props.onPublish;
    if (!run || state.busy) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await run();
    } catch (error) {
      const fallback = t("settings.mobileConnect.reach.failed");
      // A bare code, such as `publish_failed` from a host that did not come online, is not a sentence.
      // The host status then holds the cause, and the notice shows it.
      const code = error instanceof Error && /^[a-z_]+$/u.test(error.message);
      const message = code ? fallback : errorMessage(error, fallback);
      setState((draft) => {
        draft.error = message;
      });
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  };
  const publishButton = (label: string) => (
    <Show when={props.onPublish}>
      <AlertActions>
        <Button
          type="button"
          size="sm"
          loading={state.busy}
          loadingLabel={t("settings.mobileConnect.reach.publishing")}
          onClick={() => void publish()}
        >
          {label}
        </Button>
      </AlertActions>
    </Show>
  );
  return (
    <div class="settings-mobile-reach" data-settings-row="settings.mobileConnect.reach.publish">
      <Switch>
        <Match when={props.reach.state === "online"}>
          <Alert tone="success" report={false}>
            <AlertIcon>
              <CircleCheck aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.mobileConnect.reach.online.title")}</AlertTitle>
              <AlertDescription>{t("settings.mobileConnect.reach.online.description")}</AlertDescription>
            </AlertContent>
          </Alert>
        </Match>
        <Match when={props.reach.state === "starting"}>
          <Alert tone="neutral" report={false}>
            <AlertIcon>
              <LoaderCircle aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.mobileConnect.reach.starting.title")}</AlertTitle>
              <AlertDescription>{t("settings.mobileConnect.reach.starting.description")}</AlertDescription>
            </AlertContent>
          </Alert>
        </Match>
        <Match when={props.reach.state === "disconnected"}>
          <Alert tone="warning" report={false}>
            <AlertIcon>
              <RefreshCw aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.mobileConnect.reach.disconnected.title")}</AlertTitle>
              <AlertDescription>
                {hostMessage() ?? t("settings.mobileConnect.reach.disconnected.description")}
              </AlertDescription>
            </AlertContent>
            {publishButton(t("settings.mobileConnect.reach.retry"))}
          </Alert>
        </Match>
        <Match when={props.reach.state === "offline"}>
          <Alert tone="warning" report={false}>
            <AlertIcon>
              <Globe2 aria-hidden="true" />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("settings.mobileConnect.reach.offline.title")}</AlertTitle>
              <AlertDescription>
                {props.onPublish
                  ? t("settings.mobileConnect.reach.offline.description")
                  : t("settings.mobileConnect.reach.offline.where")}
              </AlertDescription>
            </AlertContent>
            {publishButton(t("settings.mobileConnect.reach.publish"))}
          </Alert>
        </Match>
      </Switch>
      <Show when={props.reach.state === "offline" || props.reach.state === "disconnected" ? state.error : null}>
        {(message) => (
          <Text class="settings-modal-error" variant="caption" role="alert">
            {props.reach.state === "offline" && hostMessage() ? `${message()} ${hostMessage()}` : message()}
          </Text>
        )}
      </Show>
    </div>
  );
}
