import type { AppLogoVariant } from "@openbot/brand";
import { AgentMark } from "@openbot/brand/agent-mark";
import { useText } from "@openbot/ui/text";
import { createEffect } from "solid-js";

// The fade takes the overlay duration. If no `animationend` comes, the splash ends this time after the
// app is ready, so it cannot cover the app.
const EXIT_LIMIT_MS = 1500;
const EXIT_ANIMATION = "startup-splash-exit";

/** The colour of the box: the logo colour of the build. The logo colour setting changes the first. */
const SPLASH_ACCENTS: Readonly<Record<AppLogoVariant, string>> = {
  production: "var(--openbot-logo-production)",
  dev: "var(--openbot-logo-dev)",
  preview: "var(--openbot-logo-preview)",
};

interface StartupSplashProps {
  variant: AppLogoVariant;
  /** The app is ready: the splash fades out. Remove it in `onExited`. */
  ready: boolean;
  onExited?: () => void;
}

/**
 * The desktop window's first screen: the agent box in the logo colour, at work until the app is
 * ready, with its eyes open and points of light in orbit. The splash then fades out.
 */
export function StartupSplash(props: StartupSplashProps) {
  const { t } = useText();
  let root: HTMLElement | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;

  function finishExit(): void {
    if (exited) return;
    exited = true;
    clearTimeout(exitTimer);
    props.onExited?.();
  }

  createEffect(
    () => props.ready,
    (ready) => {
      if (!ready) return;
      exitTimer ??= setTimeout(finishExit, EXIT_LIMIT_MS);
      return () => clearTimeout(exitTimer);
    },
  );

  createEffect(
    () => props.ready,
    (exit) => {
      // Without the stylesheet, or in a test DOM, the exit does not animate: end the splash now.
      if (exit && root && !getComputedStyle(root).animationName.includes(EXIT_ANIMATION)) queueMicrotask(finishExit);
    },
  );

  function handleAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) finishExit();
  }

  return (
    <main
      ref={(element) => {
        root = element;
      }}
      class="startup-splash"
      data-phase={props.ready ? "exit" : "loading"}
      role="status"
      aria-label={t("app.loading")}
      aria-busy={props.ready ? "false" : "true"}
      onAnimationEnd={handleAnimationEnd}
    >
      <span class="startup-splash-logo">
        <AgentMark mood="working" accent={SPLASH_ACCENTS[props.variant]} seed="startup-splash" />
      </span>
    </main>
  );
}
