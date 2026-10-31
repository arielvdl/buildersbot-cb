import type { ComponentProps, JSX } from "@solidjs/web";

/**
 * A native color input. Only it opens the color picker of the system, so the design system has no
 * drawn control in its place. The caller sets how it shows, such as visually hidden behind a menu item
 * that opens it with `showPicker()`.
 */
export function SystemColorInput(props: Omit<ComponentProps<"input">, "type">): JSX.Element {
  return <input {...props} type="color" />;
}
