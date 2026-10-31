import type { JSX } from "@solidjs/web";
import QRCode from "qrcode";
import { children, createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Spinner } from "./surface";
import { useText } from "./text";
import { cx } from "./utils";

export interface QrCodeProps {
  value: string;
  /**
   * A code that another program already encoded: rows of `1` (dark) and `0` (light), with no quiet
   * zone. The code then draws these modules, and `value` only names it. A WhatsApp pairing QR comes
   * this way, because the program that pairs prints the modules and not the text.
   */
  modules?: readonly string[] | undefined;
  label?: string;
  size?: number;
  class?: string;
  /** Small logos in the center. The code then uses the highest error correction and leaves a clear
   * hole of whole modules for them, so a camera rebuilds the missing modules. Keep the mark under a
   * third of the code's width. */
  children?: JSX.Element;
}

/** The quiet zone around the code, in modules. */
const QR_MARGIN = 2;

interface MarkBox {
  width: number;
  height: number;
}

/** The smallest odd number of modules that holds `pixels` plus one clear module on each side. A
 * code is always an odd number of modules wide, so an odd hole sits exactly in the center. */
function holeModules(pixels: number, modulePixels: number): number {
  const modules = Math.ceil(pixels / modulePixels) + 2;
  return modules % 2 === 1 ? modules : modules + 1;
}

function qrSvg(value: string, size: number, mark: MarkBox | null, modules?: readonly string[]): string {
  const code = modules ? null : QRCode.create(value, { errorCorrectionLevel: mark ? "H" : "M" });
  const count = modules ? modules.length : (code?.modules.size ?? 0);
  const dark = (row: number, column: number) =>
    modules ? modules[row]?.[column] === "1" : Boolean(code?.modules.get(row, column));
  const total = count + QR_MARGIN * 2;
  const modulePixels = size / total;
  const holeWidth = mark && mark.width > 0 ? Math.min(holeModules(mark.width, modulePixels), count) : 0;
  const holeHeight = mark && mark.height > 0 ? Math.min(holeModules(mark.height, modulePixels), count) : 0;
  const holeLeft = (count - holeWidth) / 2;
  const holeTop = (count - holeHeight) / 2;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    const inHoleRow = row >= holeTop && row < holeTop + holeHeight;
    for (let column = 0; column < count; column += 1) {
      if (inHoleRow && column >= holeLeft && column < holeLeft + holeWidth) continue;
      if (dark(row, column)) path += `M${column + QR_MARGIN} ${row + QR_MARGIN}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}

export function QrCode(props: QrCodeProps): JSX.Element {
  const { t } = useText();
  const size = () => props.size ?? 196;
  const [source, setSource] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);
  const [markBox, setMarkBox] = createSignal<MarkBox | null>(null);
  const mark = children(() => props.children);
  const hasMark = () => mark.toArray().length > 0;
  let markElement: HTMLSpanElement | undefined;
  let disposed = false;

  // The hole is cut to the size of the logos, so the code waits until they have a size. A code in a
  // hidden panel has none yet, and is drawn when the panel shows.
  onSettled(() => {
    const element = markElement;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width === 0 || height === 0) return;
      const current = markBox();
      if (current?.width !== width || current.height !== height) setMarkBox({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  createEffect(
    () => ({ value: props.value, modules: props.modules, size: size(), marked: hasMark(), box: markBox() }),
    ({ value, modules, size: requestedSize, marked, box }) => {
      if (disposed || (marked && !box)) return;
      try {
        setSource(
          `data:image/svg+xml,${encodeURIComponent(qrSvg(value, requestedSize, marked ? box : null, modules))}`,
        );
        setError(false);
      } catch {
        setSource(null);
        setError(true);
      }
    },
  );

  onCleanup(() => {
    disposed = true;
  });

  return (
    <div
      class={cx("ui-qr-code", props.class)}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      role="img"
      aria-label={props.label ?? t("app.qrCode.label")}
      aria-busy={!source() && !error() ? "true" : undefined}
    >
      <Show
        when={source()}
        fallback={
          <Show when={error()} fallback={<Spinner size="sm" />}>
            <span class="sr-only">{t("app.qrCode.unavailable")}</span>
          </Show>
        }
      >
        {(url) => <img src={url()} alt="" width={size()} height={size()} />}
      </Show>
      <Show when={hasMark()}>
        <span ref={markElement} class="ui-qr-code-mark" data-ready={source() ? "" : undefined} aria-hidden="true">
          {mark()}
        </span>
      </Show>
    </div>
  );
}
