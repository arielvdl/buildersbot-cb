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
  Text,
} from "@openbot/ui";
import { createStore, Show } from "solid-js";
import { useText } from "../../text";

/** Whether a phone can reach the server of this computer: published, being published, or not published. */
export type MobileConnectReach = "online" | "starting" | "offline";

interface MobileConnectReachNoticeProps {
  reach: MobileConnectReach;
  /** Publishes the server of this computer. Without it, the notice only tells where the switch is. */
  onPublish?: (() => Promise<void>) | undefined;
}

/**
 * Tells whether a phone can reach this computer, and publishes its server when the user selects it.
 *
 * The web app on a phone lists only published servers. A phone that signs in before this computer is
 * published shows no server and asks the user to turn on remote access, so this notice is in the Mobile
 * Connect tab and in the sign-in step of "Add phone". It publishes only on a click: a published server is
 * on the account service, and the members of the server can connect to it.
 */
export function MobileConnectReachNotice(props: MobileConnectReachNoticeProps) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{ busy: boolean; error: string | null }>({ busy: false, error: null });
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
  return (
    <div class="settings-mobile-reach">
      <Show
        when={props.reach === "online"}
        fallback={
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
            <Show when={props.onPublish}>
              <AlertActions>
                <Button
                  type="button"
                  size="sm"
                  loading={state.busy || props.reach === "starting"}
                  loadingLabel={t("settings.mobileConnect.reach.publishing")}
                  onClick={() => void publish()}
                >
                  {t("settings.mobileConnect.reach.publish")}
                </Button>
              </AlertActions>
            </Show>
          </Alert>
        }
      >
        <Alert tone="success" report={false}>
          <AlertIcon>
            <CircleCheck aria-hidden="true" />
          </AlertIcon>
          <AlertContent>
            <AlertTitle>{t("settings.mobileConnect.reach.online.title")}</AlertTitle>
            <AlertDescription>{t("settings.mobileConnect.reach.online.description")}</AlertDescription>
          </AlertContent>
        </Alert>
      </Show>
      <Show when={props.reach !== "online" && state.error}>
        {(message) => (
          <Text class="settings-modal-error" variant="caption" role="alert">
            {message()}
          </Text>
        )}
      </Show>
    </div>
  );
}
