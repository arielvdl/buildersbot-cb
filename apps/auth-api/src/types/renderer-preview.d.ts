declare module "@openbot/renderer-preview" {
  import type { JSX } from "@solidjs/web";

  export interface BuildersBotPlaygroundProps {
    variant?: "default" | "landing";
    theme?: "dark" | "light";
  }

  export function BuildersBotPlayground(props: BuildersBotPlaygroundProps): JSX.Element;
}
