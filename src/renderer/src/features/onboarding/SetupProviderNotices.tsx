import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Download,
  Progress,
  RefreshCw,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Match, Show, Switch } from "solid-js";
import { FREE_PROVIDER } from "./onboarding-provider-rows";
import type { SetupProviders } from "./SetupProviderPicker";
import { freeInstallStep, piNoticeAction, piWaiters } from "./setup-provider-notices";

export interface SetupProviderNoticesProps {
  providers: SetupProviders;
  disabled: boolean;
}

/**
 * The notices below the provider rows of setup.
 *
 * - The install suggestion of Builders, while its runtime is not on the computer that runs the
 *   providers: one action that downloads it, its progress, and a retry with the reason when it fails.
 *   It reuses the runtime download of the row, so the row and the notice show the same progress.
 * - One notice for the key providers among the rows that wait for a newer Pi, with one action,
 *   instead of the same long Pi message on each row.
 */
export function SetupProviderNotices(props: SetupProviderNoticesProps) {
  const { t, format, sourceText } = useText();
  const source = () => props.providers.props;
  const free = () => props.providers.rows().listed.find((option) => option.id === FREE_PROVIDER);
  const freeName = () => free()?.name ?? "";
  const install = () => freeInstallStep(free(), Boolean(source().onDownloadProvider));
  const freeProgress = () => free()?.runtimeStatus?.progress ?? null;
  const freeFailure = () => free()?.runtimeStatus?.message ?? null;

  const waiting = () => piWaiters(props.providers.rows().listed);
  const pi = () => props.providers.options().find((option) => option.id === "pi");
  const piAction = () =>
    piNoticeAction(pi(), {
      download: Boolean(source().onDownloadProvider),
      update: Boolean(source().onUpdateProvider),
    });
  const piVersion = () => pi()?.runtimeStatus?.availableVersion ?? pi()?.availableVersion ?? null;
  const piTitle = () => {
    const providers = format.list(waiting().map((option) => option.name));
    const version = piVersion();
    return version
      ? t("onboarding.notice.piUpdateTo", { version, providers })
      : t("onboarding.notice.piUpdate", { providers });
  };
  const runPiAction = () => {
    if (piAction() === "update") void props.providers.updateRuntime("pi");
    else void props.providers.installRuntime("pi");
  };

  return (
    <>
      <Show when={install()}>
        {(step) => (
          <Alert
            class="setup-provider-notice"
            tone={step() === "retry" ? "warning" : "neutral"}
            role="status"
            report={false}
          >
            <AlertIcon>
              <Show when={step() === "retry"} fallback={<Download aria-hidden="true" />}>
                <TriangleAlert aria-hidden="true" />
              </Show>
            </AlertIcon>
            <AlertContent>
              <Switch>
                <Match when={step() === "install"}>
                  <AlertTitle>{t("onboarding.notice.installTitle", { provider: freeName() })}</AlertTitle>
                  <AlertDescription>{t("onboarding.provider.noSignIn")}</AlertDescription>
                </Match>
                <Match when={step() === "installing"}>
                  <AlertTitle>{t("onboarding.notice.installing", { provider: freeName() })}</AlertTitle>
                  <Progress
                    value={freeProgress() ?? 0}
                    indeterminate={freeProgress() === null}
                    aria-label={t("onboarding.notice.installing", { provider: freeName() })}
                  />
                </Match>
                <Match when={step() === "finishing"}>
                  <AlertTitle>{t("onboarding.notice.finishing", { provider: freeName() })}</AlertTitle>
                  <Progress indeterminate aria-label={t("onboarding.notice.finishing", { provider: freeName() })} />
                </Match>
                <Match when={step() === "retry"}>
                  <AlertTitle>{t("onboarding.notice.installFailed", { provider: freeName() })}</AlertTitle>
                  <Show when={freeFailure()}>
                    {(reason) => <AlertDescription>{sourceText(reason())}</AlertDescription>}
                  </Show>
                </Match>
              </Switch>
            </AlertContent>
            <Show when={step() === "install" || step() === "retry"}>
              <AlertActions>
                <Button
                  type="button"
                  variant={step() === "install" ? "default" : "outline"}
                  size="xs"
                  aria-label={t(step() === "install" ? "provider.aria.install" : "provider.aria.retry", {
                    name: freeName(),
                  })}
                  disabled={props.disabled}
                  onClick={() => void props.providers.installRuntime(FREE_PROVIDER)}
                >
                  {step() === "install" ? t("provider.action.install") : t("common.retry")}
                </Button>
              </AlertActions>
            </Show>
          </Alert>
        )}
      </Show>
      <Show when={waiting().length > 0}>
        <Alert class="setup-provider-notice" tone="neutral" role="status" report={false}>
          <AlertIcon>
            <RefreshCw aria-hidden="true" />
          </AlertIcon>
          <AlertContent>
            <AlertTitle>{piTitle()}</AlertTitle>
            <Show when={piAction() === "progress"}>
              <Progress
                value={pi()?.runtimeStatus?.progress ?? 0}
                indeterminate={(pi()?.runtimeStatus?.progress ?? null) === null}
                aria-label={t("onboarding.notice.piUpdating")}
              />
            </Show>
          </AlertContent>
          <Show when={piAction() === "download" || piAction() === "update"}>
            <AlertActions>
              <Button type="button" variant="outline" size="xs" disabled={props.disabled} onClick={runPiAction}>
                {t("onboarding.notice.piAction")}
              </Button>
            </AlertActions>
          </Show>
        </Alert>
      </Show>
    </>
  );
}
