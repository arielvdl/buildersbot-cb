import { isSidebarSectionIcon, isSidebarSectionImage, SIDEBAR_SECTION_IMAGE_TYPES } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  clampSectionIconCrop,
  panSectionIconCrop,
  sectionIconDrawRect,
  sectionIconFillCrop,
  sectionIconFillZoom,
  sectionIconFitCrop,
  sectionIconMaxZoom,
  sectionIconNaturalSize,
  zoomSectionIconCrop,
} from "../../../../../packages/ui/src/features/sidebar/section-icon-crop";
import {
  SIDEBAR_SECTION_SVG_SOURCE_BYTES,
  sectionIconSvgDataUrl,
  sidebarSectionIconPick,
  sidebarSectionIconSourceProblem,
  sidebarSectionSvgProblem,
} from "../../../../../packages/ui/src/features/sidebar/section-icon-image";

const FRAME = 200;
const WIDE = { width: 400, height: 100 };
const TALL = { width: 100, height: 300 };
const SQUARE = { width: 100, height: 100 };

describe("the crop of an icon image", () => {
  it("starts at Fit and fills the frame at the ratio of the long side to the short side", () => {
    expect(sectionIconFitCrop()).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(sectionIconFillZoom(WIDE)).toBe(4);
    expect(sectionIconFillCrop(TALL)).toEqual({ zoom: 3, x: 0, y: 0 });
    expect(sectionIconFillZoom(SQUARE)).toBe(1);
  });

  it("zooms to 4x, and further for a long image so that it can fill the frame", () => {
    expect(sectionIconMaxZoom(SQUARE)).toBe(4);
    expect(sectionIconMaxZoom({ width: 1000, height: 100 })).toBe(10);
  });

  it("counts an image with no size as 96 x 96", () => {
    expect(sectionIconNaturalSize(0, 0)).toEqual({ width: 96, height: 96 });
    expect(sectionIconNaturalSize(300, 0)).toEqual({ width: 96, height: 96 });
    expect(sectionIconNaturalSize(300, 150)).toEqual({ width: 300, height: 150 });
  });

  it("keeps the zoom between Fit and the largest zoom, and a value that is not a number at its start", () => {
    expect(clampSectionIconCrop({ zoom: 0.2, x: 0, y: 0 }, SQUARE, FRAME).zoom).toBe(1);
    expect(clampSectionIconCrop({ zoom: 9, x: 0, y: 0 }, SQUARE, FRAME).zoom).toBe(4);
    expect(clampSectionIconCrop({ zoom: Number.NaN, x: Number.NaN, y: 5 }, SQUARE, FRAME)).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
  });

  it("keeps a small side inside the frame and a large side over the frame", () => {
    // At Fit, the wide image is 200 x 50: it can move up and down inside the frame, not to the sides.
    expect(panSectionIconCrop(sectionIconFitCrop(), 90, 90, WIDE, FRAME)).toEqual({ zoom: 1, x: 0, y: 75 });
    // At Fill, it is 800 x 200: it can move to the sides until an edge meets the frame, not up or down.
    expect(panSectionIconCrop(sectionIconFillCrop(WIDE), -500, 40, WIDE, FRAME)).toEqual({ zoom: 4, x: -300, y: 0 });
  });

  it("keeps the point under the frame center when it zooms", () => {
    expect(zoomSectionIconCrop({ zoom: 2, x: 20, y: -10 }, 2, SQUARE, FRAME)).toEqual({ zoom: 4, x: 40, y: -20 });
    // Back to Fit, the square image fills the frame, so the pan goes back to the center.
    expect(zoomSectionIconCrop({ zoom: 2, x: 20, y: -10 }, 0.1, SQUARE, FRAME)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("draws on the output canvas what the frame shows", () => {
    expect(sectionIconDrawRect(sectionIconFitCrop(), WIDE, FRAME, 96)).toEqual({ x: 0, y: 36, width: 96, height: 24 });
    expect(sectionIconDrawRect(sectionIconFillCrop(WIDE), WIDE, FRAME, 96)).toEqual({
      x: -144,
      y: 0,
      width: 384,
      height: 96,
    });
    // A move of 100 frame pixels to the right is a move of 48 canvas pixels.
    expect(sectionIconDrawRect({ zoom: 4, x: 100, y: 0 }, WIDE, FRAME, 96).x).toBe(-96);
    // An output of 100 gives the place in percent, which the preview uses.
    const percent = sectionIconDrawRect(sectionIconFitCrop(), TALL, FRAME, 100);
    expect(percent.x).toBeCloseTo(100 / 3);
    expect(percent.width).toBeCloseTo(100 / 3);
    expect([percent.y, percent.height]).toEqual([0, 100]);
  });
});

describe("an icon image file", () => {
  it("is refused before it is read when its type is not an image type or it is too large", () => {
    expect(sidebarSectionIconSourceProblem({ type: "application/pdf", size: 900 })).toBe("type");
    expect(sidebarSectionIconSourceProblem({ type: "", size: 900 })).toBe("type");
    expect(sidebarSectionIconSourceProblem({ type: "image/png", size: 11 * 1024 * 1024 })).toBe("size");
    expect(sidebarSectionIconSourceProblem({ type: "image/png", size: 0 })).toBe("size");
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]) {
      expect(sidebarSectionIconSourceProblem({ type, size: 400 * 1024 })).toBeNull();
    }
  });

  it("can be an SVG file of at most 512 KB", () => {
    const type = "image/svg+xml";
    expect(sidebarSectionIconSourceProblem({ type, size: SIDEBAR_SECTION_SVG_SOURCE_BYTES })).toBeNull();
    expect(sidebarSectionIconSourceProblem({ type, size: SIDEBAR_SECTION_SVG_SOURCE_BYTES + 1 })).toBe("svgSize");
    expect(sidebarSectionIconSourceProblem({ type, size: 2 * 1024 * 1024 })).toBe("svgSize");
  });

  it("is the first image of a drop or a paste, and the others are counted", () => {
    const text = { type: "text/plain", name: "notes.txt" };
    const png = { type: "image/png", name: "one.png" };
    const svg = { type: "image/svg+xml", name: "two.svg" };
    expect(sidebarSectionIconPick([text, png, svg])).toEqual({ file: png, ignored: 2 });
    expect(sidebarSectionIconPick([svg])).toEqual({ file: svg, ignored: 0 });
    expect(sidebarSectionIconPick([text])).toEqual({ file: null, ignored: 1 });
    expect(sidebarSectionIconPick([])).toEqual({ file: null, ignored: 0 });
  });
});

describe("the text of an SVG file", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

  it("is read when it starts as an SVG document", () => {
    expect(sidebarSectionSvgProblem(svg)).toBeNull();
    expect(
      sidebarSectionSvgProblem(`﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n${svg}`),
    ).toBeNull();
    // A link to a part of the same file is not a web address.
    expect(sidebarSectionSvgProblem(svg.replace("<circle", '<use href="#dot"/><circle'))).toBeNull();
  });

  it("is refused when it is not an SVG document", () => {
    expect(sidebarSectionSvgProblem("<html><body><svg></svg></body></html>")).toBe("invalid");
    expect(sidebarSectionSvgProblem("not an image")).toBe("invalid");
    expect(sidebarSectionSvgProblem("")).toBe("invalid");
    expect(sidebarSectionSvgProblem("<svgx></svgx>")).toBe("invalid");
  });

  it("is refused for a script when it has a script, a foreign object or a javascript: address", () => {
    const scripts = [
      svg.replace("<circle", "<script>alert(1)</script><circle"),
      svg.replace("<circle", "<SCRIPT>alert(1)</SCRIPT><circle"),
      svg.replace("<circle", "<foreignObject><div>x</div></foreignObject><circle"),
      svg.replace("<circle", '<a href="javascript:alert(1)"><circle'),
    ];
    for (const text of scripts) expect(sidebarSectionSvgProblem(text)).toBe("script");
  });

  it("is refused for a link when it links to a web address", () => {
    const links = [
      svg.replace("<circle", '<image href="https://example.com/a.png"/><circle'),
      svg.replace("<circle", "<image xlink:href='http://example.com/a.png'/><circle"),
      svg.replace("<circle", "<image href = https://example.com/a.png /><circle"),
    ];
    for (const text of links) expect(sidebarSectionSvgProblem(text)).toBe("link");
  });

  it("loads as a data: URL that keeps the text", () => {
    const url = sectionIconSvgDataUrl(svg);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(svg);
  });
});

describe("the stored icon image", () => {
  it("is never an SVG: only PNG and WebP are stored", () => {
    expect(SIDEBAR_SECTION_IMAGE_TYPES).not.toContain("image/svg+xml");
    const svgDataUrl = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
    expect(isSidebarSectionImage(svgDataUrl)).toBe(false);
    expect(isSidebarSectionIcon({ kind: "image", dataUrl: svgDataUrl })).toBe(false);
  });
});
