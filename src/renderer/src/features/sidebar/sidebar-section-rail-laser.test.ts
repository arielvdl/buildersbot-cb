// @vitest-environment node

// The laser of a section that works runs for as long as its agents work, on each running tile at
// once. An infinite animation that changes a custom property, a gradient, a filter or a shadow makes
// the main thread style and paint for each frame, which the performance review measured as a real CPU
// cost. A turn of a compositor layer costs no main-thread work. This test reads the stylesheet and
// keeps the laser on the cheap path. The checker also runs on bad samples, so it cannot pass blind.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STYLESHEET = resolve(
  import.meta.dirname,
  "../../../../../packages/ui/src/features/sidebar/sidebar-section-rail.css",
);
const LASER = "section-rail-laser";
/** The properties that a compositor animates without the main thread. */
const COMPOSITOR_PROPERTIES = new Set(["transform", "rotate", "opacity"]);

interface CssBlock {
  prelude: string;
  body: string;
  children: CssBlock[];
}

/** The blocks of a stylesheet: rules, at-rules and their children. Enough for this one file. */
function cssBlocks(source: string): CssBlock[] {
  const root: CssBlock = { prelude: "", body: "", children: [] };
  const stack = [root];
  let buffer = "";
  for (const char of source.replaceAll(/\/\*[\s\S]*?\*\//gu, "")) {
    const current = stack.at(-1) ?? root;
    if (char === "{") {
      const block: CssBlock = { prelude: buffer.trim(), body: "", children: [] };
      current.children.push(block);
      stack.push(block);
      buffer = "";
    } else if (char === "}") {
      current.body += buffer;
      if (stack.length > 1) stack.pop();
      buffer = "";
    } else if (char === ";") {
      current.body += `${buffer};`;
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return root.children;
}

function declarations(block: CssBlock): Array<[property: string, value: string]> {
  return block.body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes(":"))
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    });
}

/** Every style rule with the at-rule preludes around it, outside the keyframes. */
function styleRules(blocks: CssBlock[], context: string[] = []): Array<{ rule: CssBlock; context: string[] }> {
  return blocks.flatMap((block) => {
    if (block.prelude.startsWith("@keyframes")) return [];
    if (block.prelude.startsWith("@")) return styleRules(block.children, [...context, block.prelude]);
    return [{ rule: block, context }];
  });
}

/** What makes the laser cost main-thread work per frame, or keep running for reduced motion. */
function laserCssProblems(source: string): string[] {
  const blocks = cssBlocks(source);
  const keyframes = new Map(
    blocks
      .filter((block) => block.prelude.startsWith("@keyframes"))
      .map((block) => [block.prelude.replace("@keyframes", "").trim(), block.children]),
  );
  const laserRules = styleRules(blocks).filter(({ rule }) => rule.prelude.includes(LASER));
  const problems: string[] = [];
  if (laserRules.length === 0) problems.push("no laser rule");
  if (blocks.some((block) => block.prelude.startsWith("@property"))) {
    problems.push("a registered custom property: an animation of it styles and paints each frame");
  }

  const animated = new Set<string>();
  for (const { rule, context } of laserRules) {
    for (const [property, value] of declarations(rule)) {
      if (property === "animation" || property === "animation-name") {
        for (const word of value.split(/[\s,]+/u)) if (keyframes.has(word)) animated.add(word);
      }
      if (property === "filter" || property === "backdrop-filter") {
        problems.push(`${rule.prelude}: a filter is drawn again for each frame of the turn`);
      }
      if (property.startsWith("transition") && /filter|shadow|--/u.test(value)) {
        problems.push(`${rule.prelude}: a transition of a filter, a shadow or a custom property`);
      }
      if (property === "will-change" && value !== "transform" && value !== "auto") {
        problems.push(`${rule.prelude}: will-change ${value} is not a compositor property`);
      }
      const reduced = context.some((prelude) => /prefers-reduced-motion:\s*reduce/u.test(prelude));
      if (property === "animation" && value !== "none" && reduced) {
        problems.push(`${rule.prelude}: an animation with reduced motion`);
      }
    }
  }
  if (animated.size === 0) problems.push("no laser animation");
  for (const name of animated) {
    for (const frame of keyframes.get(name) ?? []) {
      for (const [property] of declarations(frame)) {
        if (!COMPOSITOR_PROPERTIES.has(property)) {
          problems.push(`@keyframes ${name} animates ${property}, which is not a compositor property`);
        }
      }
    }
  }

  const stopsForReducedMotion = laserRules.some(
    ({ rule, context }) =>
      context.some((prelude) => /prefers-reduced-motion:\s*reduce/u.test(prelude)) &&
      declarations(rule).some(([property, value]) => property === "animation" && value === "none"),
  );
  if (!stopsForReducedMotion) problems.push("no reduced-motion rule stops the laser");

  const pausesWhenHidden = laserRules.some(({ rule }) =>
    declarations(rule).some(
      ([property, value]) => property === "animation-play-state" && value.startsWith("var(--section-rail-laser-play"),
    ),
  );
  if (!pausesWhenHidden) problems.push("the laser does not read the play state that the rail sets");
  return problems;
}

const GOOD = `
.section-rail-laser-ring::before {
  animation: section-rail-laser 2.4s linear infinite;
  animation-play-state: var(--section-rail-laser-play, running);
  will-change: transform;
}
@keyframes section-rail-laser { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) {
  .section-rail-laser-ring::before { animation: none; }
}
`;

describe("the laser of a section that works", () => {
  it("turns only a compositor layer, pauses while hidden, and stops for reduced motion", () => {
    expect(laserCssProblems(readFileSync(STYLESHEET, "utf8"))).toEqual([]);
  });

  it("passes a laser that turns a layer", () => {
    expect(laserCssProblems(GOOD)).toEqual([]);
  });

  it("fails a laser that animates a custom property, a filter or a shadow", () => {
    const sweep = `
@property --sweep { syntax: "<angle>"; inherits: false; initial-value: 0turn; }
.section-rail-laser-ring::before {
  animation: laser-sweep 2.4s linear infinite;
  animation-play-state: var(--section-rail-laser-play, running);
  filter: blur(2px);
  transition: box-shadow 1s;
  will-change: filter;
}
@keyframes laser-sweep { to { --sweep: 1turn; box-shadow: 0 0 4px; filter: blur(4px); } }
@media (prefers-reduced-motion: reduce) {
  .section-rail-laser-ring::before { animation: none; }
}
`;
    expect(laserCssProblems(sweep)).toEqual([
      "a registered custom property: an animation of it styles and paints each frame",
      ".section-rail-laser-ring::before: a filter is drawn again for each frame of the turn",
      ".section-rail-laser-ring::before: a transition of a filter, a shadow or a custom property",
      ".section-rail-laser-ring::before: will-change filter is not a compositor property",
      "@keyframes laser-sweep animates --sweep, which is not a compositor property",
      "@keyframes laser-sweep animates box-shadow, which is not a compositor property",
      "@keyframes laser-sweep animates filter, which is not a compositor property",
    ]);
  });

  it("fails a laser that keeps turning for reduced motion, or that the hidden document does not pause", () => {
    const always = `
.section-rail-laser-ring::before { animation: section-rail-laser 2.4s linear infinite; }
@keyframes section-rail-laser { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) {
  .section-rail-laser-ring::before { animation: section-rail-laser 9s linear infinite; }
}
`;
    expect(laserCssProblems(always)).toEqual([
      ".section-rail-laser-ring::before: an animation with reduced motion",
      "no reduced-motion rule stops the laser",
      "the laser does not read the play state that the rail sets",
    ]);
  });
});
