import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";
import { SectionEmojiPicker, SectionGlyphPicker } from "@openbot/ui/features/sidebar/SidebarSectionIconPicker";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  window.localStorage.clear();
});

const options = (name: string) => screen.getByRole("listbox", { name }).querySelectorAll('[role="option"]');

describe("the icon picker", () => {
  it("loads the library, searches in Portuguese, and picks with the keyboard", async () => {
    const onSelect = vi.fn<(glyph: SidebarSectionGlyph) => void>();
    render(() => <SectionGlyphPicker selected={null} onSelect={onSelect} />);
    const search = screen.getByRole("searchbox", { name: "Search icons…" });
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Icons" })).toBeInTheDocument());

    // The grid renders its first rows; the set size tells the whole list.
    const all = options("Icons");
    expect(all.length).toBeLessThan(200);
    expect(all[0]).toHaveAttribute("aria-setsize", "434");

    fireEvent.input(search, { target: { value: "segurança" } });
    await waitFor(() => expect(options("Icons")[0]).toHaveAttribute("aria-label", "Shield"));

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options("Icons")[0]);
    fireEvent.keyDown(document.activeElement ?? search, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options("Icons")[1]);
    fireEvent.keyDown(document.activeElement ?? search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.input(search, { target: { value: "seguranca" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("shield");
  });

  it("says when no icon matches", async () => {
    render(() => <SectionGlyphPicker selected={null} onSelect={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Icons" })).toBeInTheDocument());
    fireEvent.input(screen.getByRole("searchbox"), { target: { value: "xyzzy" } });
    await waitFor(() => expect(screen.getByText("No icon for “xyzzy”")).toBeInTheDocument());
  });

  it("marks the selected icon", async () => {
    render(() => <SectionGlyphPicker selected="rocket" onSelect={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Rocket" })).toHaveAttribute("aria-selected", "true"),
    );
  });
});

describe("the emoji picker", () => {
  it("searches in Portuguese and picks an emoji with a click", async () => {
    const onSelect = vi.fn<(emoji: string) => void>();
    render(() => <SectionEmojiPicker selected={null} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Emoji" })).toBeInTheDocument());
    fireEvent.input(screen.getByRole("searchbox", { name: "Search emoji…" }), { target: { value: "foguete" } });
    await waitFor(() => expect(options("Emoji")[0]).toHaveAttribute("aria-label", "rocket"));
    fireEvent.click(options("Emoji")[0] as Element);
    expect(onSelect).toHaveBeenLastCalledWith("🚀");
  });

  it("gives people and hands the chosen skin tone", async () => {
    const onSelect = vi.fn<(emoji: string) => void>();
    render(() => <SectionEmojiPicker selected={null} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Emoji" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Skin tone/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Medium" }));
    fireEvent.input(screen.getByRole("searchbox"), { target: { value: "woman technologist" } });
    await waitFor(() => expect(options("Emoji")[0]).toHaveAttribute("aria-label", "woman technologist"));
    fireEvent.click(options("Emoji")[0] as Element);
    expect(onSelect).toHaveBeenLastCalledWith("👩🏽‍💻");
  });
});
