import { APP_LOGO_COLOR_HEX, APP_LOGO_COLORS, APP_LOGO_EYE_HEX, type AppLogoColor } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { useText } from "../../text";

const COLOR_LABEL_KEYS = {
  noite: "settings.logoColor.noite",
  dia: "settings.logoColor.dia",
  signal: "settings.logoColor.signal",
  traco: "settings.logoColor.traco",
  papel: "settings.logoColor.papel",
  grafite: "settings.logoColor.grafite",
  lima: "settings.logoColor.lima",
  vidro: "settings.logoColor.vidro",
} as const satisfies Record<AppLogoColor, AppTextKey>;

export interface LogoColorPickerProps {
  value: AppLogoColor;
  onChange: (value: AppLogoColor) => void;
}

/**
 * One swatch for each colorway of the cube mark, in the same shape as the agent avatar color grid.
 * A swatch is the logo in miniature: the face of the mark and the eye that sits on it.
 */
export function LogoColorPicker(props: LogoColorPickerProps): JSX.Element {
  const { t } = useText();
  return (
    <fieldset class="logo-color-grid" aria-label={t("settings.logoColor.title")}>
      <For each={APP_LOGO_COLORS}>
        {(color) => (
          <Button
            variant="ghost"
            type="button"
            class={["logo-color-choice", { "logo-color-choice-selected": props.value === color }]}
            aria-label={t(COLOR_LABEL_KEYS[color])}
            aria-pressed={props.value === color ? "true" : "false"}
            data-cuelume-tap="select"
            onClick={() => props.onChange(color)}
          >
            <span class="logo-color-swatch" style={{ background: APP_LOGO_COLOR_HEX[color] }}>
              <span class="logo-color-swatch-eye" style={{ background: APP_LOGO_EYE_HEX[color] }} />
            </span>
          </Button>
        )}
      </For>
    </fieldset>
  );
}
