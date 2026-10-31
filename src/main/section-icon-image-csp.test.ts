// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./content-security-policy";

/** The files of the section icon editor that read, show or draw a picked image. */
const EDITOR_FILES = [
  "section-icon-image.ts",
  "SidebarSectionIconCrop.tsx",
  "SidebarSectionIconDialog.tsx",
  "SidebarSectionIconPicker.tsx",
  "SidebarSectionMark.tsx",
];

function editorSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../packages/ui/src/features/sidebar/${name}`, import.meta.url)),
    "utf8",
  );
}

function imageSources(packaged: boolean): string[] {
  const directive = buildContentSecurityPolicy(packaged)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("img-src "));
  return directive?.split(/\s+/).slice(1) ?? [];
}

describe("the section icon image under the app's Content Security Policy", () => {
  it("relies on data: images, which the policy allows, and not on blob: images, which it refuses", () => {
    for (const packaged of [true, false]) {
      expect(imageSources(packaged)).toContain("data:");
      expect(imageSources(packaged)).not.toContain("blob:");
    }
  });

  it("never makes an object URL for an image in the editor", () => {
    for (const name of EDITOR_FILES) expect(editorSource(name), name).not.toContain("createObjectURL");
  });

  it("decodes a raster file with createImageBitmap and an SVG file from a data: URL", () => {
    const source = editorSource("section-icon-image.ts");
    expect(source).toContain("createImageBitmap(file)");
    expect(source).toContain("data:image/svg+xml;charset=utf-8,");
    expect(source).toContain("readAsDataURL");
  });
});
