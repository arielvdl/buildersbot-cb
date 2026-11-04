// dmg-background-game.svg.js — arte do DMG estilo game com os personagens-cubo do Builders Bot
// Uso: bun scripts/dmg-background-game.js out.png
import sharp from "sharp";

const W = 1360, H = 1012;

// ---------- personagem: cubo 3D com carinha (olhos+boca) e bordas brilhantes ----------
function cubeBot(cx, cy, size, colors, opts = {}) {
  const { tilt = 0, label = "", glowColor } = opts;
  const s = size;
  const [edge, top, left, right] = colors;
  const hx = s * 0.5, hy = s * 0.29;
  const dh = s * 0.56;
  const topFace = `M ${cx} ${cy - dh / 2 - hy} L ${cx + hx} ${cy - dh / 2} L ${cx} ${cy - dh / 2 + hy} L ${cx - hx} ${cy - dh / 2} Z`;
  const leftFace = `M ${cx - hx} ${cy - dh / 2} L ${cx} ${cy - dh / 2 + hy} L ${cx} ${cy + dh / 2 + hy} L ${cx - hx} ${cy + dh / 2} Z`;
  const rightFace = `M ${cx + hx} ${cy - dh / 2} L ${cx} ${cy - dh / 2 + hy} L ${cx} ${cy + dh / 2 + hy} L ${cx + hx} ${cy + dh / 2} Z`;
  // olhos na face esquerda-frontal + bocinha
  const ey = cy + s * 0.02;
  const e1x = cx - hx * 0.55, e2x = cx - hx * 0.1;
  const eyeRx = s * 0.055, eyeRy = s * 0.075;
  const mouth = `M ${cx - hx * 0.38} ${cy + s * 0.16} Q ${cx - hx * 0.3} ${cy + s * 0.2} ${cx - hx * 0.22} ${cy + s * 0.16}`;
  const labelSvg = label
    ? `<text x="${cx}" y="${cy + dh / 2 + hy + s * 0.22}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${Math.max(13, s * 0.13)}" fill="#b8aed4" opacity="0.9">${label}</text>`
    : "";
  return `<g transform="rotate(${tilt} ${cx} ${cy})">
    <g opacity="0.95">
      <path d="${leftFace}" fill="${left}"/>
      <path d="${rightFace}" fill="${right}"/>
      <path d="${topFace}" fill="${top}"/>
      <path d="${topFace}" fill="none" stroke="${edge}" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="${leftFace}" fill="none" stroke="${edge}" stroke-width="2.5" stroke-linejoin="round" opacity="0.85"/>
      <path d="${rightFace}" fill="none" stroke="${edge}" stroke-width="2.5" stroke-linejoin="round" opacity="0.85"/>
    </g>
    <ellipse cx="${e1x}" cy="${ey}" rx="${eyeRx}" ry="${eyeRy}" fill="#141018"/>
    <ellipse cx="${e2x}" cy="${ey}" rx="${eyeRx}" ry="${eyeRy}" fill="#141018"/>
    <circle cx="${e1x - eyeRx * 0.35}" cy="${ey - eyeRy * 0.4}" r="${eyeRx * 0.34}" fill="#fff" opacity="0.95"/>
    <circle cx="${e2x - eyeRx * 0.35}" cy="${ey - eyeRy * 0.4}" r="${eyeRx * 0.34}" fill="#fff" opacity="0.95"/>
    <path d="${mouth}" fill="none" stroke="#141018" stroke-width="${s * 0.035}" stroke-linecap="round"/>
    ${labelSvg}
    <circle cx="${cx + hx * 1.25}" cy="${cy - dh * 0.7}" r="${s * 0.045}" fill="${glowColor || edge}" opacity="0.9"/>
  </g>`;
}

// paletas: [borda/brilho, topo, esquerda, direita] — tons translucidos neon sobre fundo escuro
const P = {
  green:  ["#7dffb0", "#2f7d54", "#246044", "#1c4f38"],
  purple: ["#c39bff", "#6a3fa8", "#55308c", "#44266f"],
  orange: ["#ffb35c", "#b06a1e", "#8f5216", "#744111"],
  pink:   ["#ff8fb0", "#b23b63", "#912c50", "#742241"],
  blue:   ["#8fb4ff", "#3f5fb8", "#304a94", "#243974"],
};

// [cx, cy, size, paleta, tilt, label]
const cast = [
  [240, 300, 150, "green",  -5, "✔ feito"],
  [560, 210, 130, "purple",  6, "lendo"],
  [1120, 190, 140, "orange", -6, "rodando"],
  [1250, 470, 130, "purple",  5, ""],
  [180, 560, 140, "pink",    -4, "pensando"],
  [150, 900, 155, "green",    4, "✔ deploy"],
  [700, 930, 140, "pink",    -3, "lendo"],
  [1170, 900, 145, "green",  -5, "rodando"],
  [620, 610, 95, "blue",      8, ""],
  [980, 640, 90, "green",    -8, ""],
];

const bots = cast
  .map(([x, y, s, p, t, l]) => cubeBot(x, y, s, P[p], { tilt: t, label: l }))
  .join("\n");

// ---------- tabuleiro isometrico escuro (grid) ----------
const gx0 = 60, gy0 = 560, tile = 118, rows = 7, cols = 7;
let grid = "";
for (let r = 0; r <= rows; r++) {
  const x1 = gx0 + r * tile, y1 = gy0 + r * tile * 0.5;
  const x2 = x1 + cols * tile, y2 = y1 - cols * tile * 0.5;
  grid += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2b2438" stroke-width="2"/>`;
}
for (let c = 0; c <= cols; c++) {
  const x1 = gx0 + c * tile, y1 = gy0 - c * tile * 0.5;
  const x2 = x1 + rows * tile, y2 = y1 + rows * tile * 0.5;
  grid += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2b2438" stroke-width="2"/>`;
}

// brilhos
let sparkles = "";
const pts = [[520, 120], [890, 105], [1330, 120], [60, 400], [440, 870], [1320, 700], [760, 70], [1050, 760]];
for (const [x, y] of pts) {
  sparkles += `<g transform="translate(${x},${y})" opacity="0.55">
    <line x1="-9" y1="0" x2="9" y2="0" stroke="#8fb4ff" stroke-width="4" stroke-linecap="round"/>
    <line x1="0" y1="-9" x2="0" y2="9" stroke="#8fb4ff" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

// seta curva tracejada entre os dois icons slots
const arrow = `
  <path d="M 500 480 Q 680 350 870 478" fill="none" stroke="#9b6ede" stroke-width="6" stroke-dasharray="2 16" stroke-linecap="round"/>
  <path d="M 870 478 L 842 458 L 846 494 Z" fill="#9b6ede"/>`;

// halos sob os icones
const glows = `
  <ellipse cx="470" cy="510" rx="180" ry="62" fill="url(#glow)"/>
  <ellipse cx="970" cy="510" rx="180" ry="62" fill="url(#glow)"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="vig" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#241d31"/>
      <stop offset="1" stop-color="#171220"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#efe8ff" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#efe8ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <g opacity="0.55">${grid}</g>
  ${glows}
  ${bots}
  ${arrow}
  ${sparkles}
</svg>`;

const out = process.argv[2] || "/Users/arielsilva/Documents/PROJETOS/buildersbot-cb/build/dmg-background@2x.png";
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("saved", out);
