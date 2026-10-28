// The Builders Bot mark as plain data, so that a canvas can draw the same mark that
// `AppLogo` draws as SVG: the social cards in apps/auth-api do.

/** The mark is a square of this side, in its own units. */
export const APP_LOGO_SIZE = 240;
/** The corner radius of the square, in the same units. */
export const APP_LOGO_CORNER = 50;

/**
 * The cube of the app icon, in a 100-unit box. The three faces are drawn in this order, so the
 * left face covers the top one and the right face covers both at the seams.
 */
export const APP_LOGO_CUBE = {
  /** Translate and scale that fit the cube into `APP_LOGO_SIZE`, with the icon's own margin. */
  fit: "translate(14 14) scale(2.12)",
  top: "M50 16 L84 33 L50 50 L16 33 Z",
  left: "M16 33 L50 50 L50 84 L16 67 Z",
  right: "M84 33 L84 67 L50 84 L50 50 Z",
  outline: "M50 16 L84 33 L84 67 L50 84 L16 67 L16 33 Z",
  /** Each eye is one chevron on the left face. */
  eyes: {
    left: "29.6 48.2 31.55 43.7 38 48.2",
    right: "41.6 48.2 43.55 43.7 50 48.2",
  },
  /** The point of the mark under the eyes. */
  dot: { cx: 43.1, cy: 54.8, r: 2.6 },
} as const;

/** Each eye is one scribbled stroke, as SVG `points`. The pre-cube mark, kept for the canvas. */
export const APP_LOGO_EYE_POINTS = {
  left: "43.55 93.61 64.69 81.41 36.48 108.04 79.67 83.11 35.93 122.88 91.58 90.74 38.9 132.69 97.66 98.76 42.44 138.88 100.43 105.4 46.9 143.83 101.97 112.04 55.08 149.51 101.83 122.52 73.01 152.43 94.14 140.23",
  right:
    "145.65 93.61 166.79 81.41 140.83 101.52 175.58 81.46 138.3 109.53 183.18 83.63 137.55 117.43 189.67 87.33 139.67 129.39 197.88 95.78 142.92 136.32 201.52 102.48 149.03 143.86 204.07 112.08 159.14 150.37 203.51 124.75 169.28 152.61 199.82 134.98",
} as const;
