import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Match, Switch } from "solid-js";

export interface ConsentNoticeProps {
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
}

// Private-use characters, which no catalog text contains, mark where each link goes.
const TERMS_MARKER = "";
const PRIVACY_MARKER = "";
const MARKER_PATTERN = /(|)/;

/** Says that the user accepts the Terms of Service, with the two document names as links. */
export function ConsentNotice(props: ConsentNoticeProps) {
  const { t } = useText();
  /** The notice in the reading order of each language. */
  const parts = () =>
    t("onboarding.consent.notice", { terms: TERMS_MARKER, privacy: PRIVACY_MARKER })
      .split(MARKER_PATTERN)
      .filter(Boolean);
  return (
    <p class="first-run-consent-notice">
      <For each={parts()}>
        {(part) => (
          <Switch fallback={part}>
            <Match when={part === TERMS_MARKER}>
              <Button type="button" variant="link" class="first-run-consent-link" onClick={() => props.onOpenTerms()}>
                {t("onboarding.consent.termsLink")}
              </Button>
            </Match>
            <Match when={part === PRIVACY_MARKER}>
              <Button type="button" variant="link" class="first-run-consent-link" onClick={() => props.onOpenPrivacy()}>
                {t("onboarding.consent.privacyLink")}
              </Button>
            </Match>
          </Switch>
        )}
      </For>
    </p>
  );
}
